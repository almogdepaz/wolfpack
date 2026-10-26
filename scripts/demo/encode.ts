#!/usr/bin/env bun
/**
 * Encodes recorded demo frames (from demo:record) into the site loops, README
 * GIFs and per-scene sources for the promo cut. Needs ffmpeg >= 6 via
 * WOLFPACK_FFMPEG (see CONTRIBUTING.md, "Site and demo media").
 *
 *   bun run demo:encode [--target <name>[,<name>]|all] [--in .demo-out] [--keep-frames] [--list]
 *
 * Each target cuts a frame range between two recorder checkpoints, holds the
 * last frame, optionally speeds the clip up, and enforces its duration/size
 * budget (a miss fails the run instead of shipping an oversized file).
 * Results and ffprobe metadata go to <in>/encode.json. A scene's screencast
 * frames are deleted only when every target that reads that scene was encoded
 * in this run (see scenesSafeToDelete), and never with --keep-frames.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DEMO_OUT, FFMPEG_TOOL, assertFreeDisk, ffprobeFor, parseArgs, resolveTool, type Frame } from "./lib";

export interface EncodeTarget {
  readonly name: string;
  readonly scene: string;
  /** Screencast segment directory inside the scene (default "frames"). */
  readonly segment?: string;
  /** Output path relative to the demo output root. */
  readonly out: string;
  readonly kind: "mp4" | "gif";
  /** Checkpoint names bounding the cut; omitted = whole segment. */
  readonly from?: string;
  readonly to?: string;
  /** Seconds to hold the last frame. */
  readonly holdEnd?: number;
  /** Playback speed multiplier (> 1 shortens). */
  readonly speed?: number;
  readonly width: number;
  readonly fps: number;
  readonly crf?: number;
  readonly maxSeconds?: number;
  readonly maxBytes?: number;
}

const MB = 1024 * 1024;

export const TARGETS: readonly EncodeTarget[] = [
  { name: "desktop-source", scene: "desktop", out: "desktop/desktop.mp4", kind: "mp4", width: 1600, fps: 30, crf: 18, holdEnd: 1 },
  { name: "mobile-source", scene: "mobile", out: "mobile/mobile.mp4", kind: "mp4", width: 780, fps: 30, crf: 18, holdEnd: 1 },
  { name: "cli-source", scene: "cli", segment: "frames-cli", out: "cli/cli.mp4", kind: "mp4", width: 1920, fps: 30, crf: 18 },
  ...["title", "privacy", "install", "end"].map((card): EncodeTarget => ({
    name: `card-${card}`, scene: "cards", segment: `frames-${card}`, out: `cards/${card}.mp4`, kind: "mp4", width: 1920, fps: 30, crf: 18,
  })),
  {
    name: "hero", scene: "desktop", out: "site/wolfpack-usage-demo.mp4", kind: "mp4",
    from: "s1-dashboard", to: "s3-grid", holdEnd: 1.2, speed: 1.15, width: 1280, fps: 30, crf: 26, maxSeconds: 22, maxBytes: 1.5 * MB,
  },
  {
    name: "phone", scene: "mobile", out: "site/wolfpack-mobile-demo.mp4", kind: "mp4",
    from: "s5-dashboard", holdEnd: 1, speed: 1.1, width: 780, fps: 30, crf: 27, maxSeconds: 15, maxBytes: 0.8 * MB,
  },
  {
    name: "readme-desktop-gif", scene: "desktop", out: "readme/wolfpack-usage-demo.gif", kind: "gif",
    from: "s1-dashboard", to: "s3-switched", holdEnd: 1.2, speed: 1.2, width: 900, fps: 6, maxSeconds: 15, maxBytes: 2.5 * MB,
  },
  {
    name: "readme-mobile-gif", scene: "mobile", out: "readme/wolfpack-mobile-demo.gif", kind: "gif",
    from: "s5-dashboard", holdEnd: 1, speed: 1.2, width: 440, fps: 5, maxSeconds: 15, maxBytes: 1.1 * MB,
  },
];

/**
 * Scenes whose frames may be deleted after a run: every target that reads the
 * scene must have been encoded in that run, so a single `--target hero` never
 * destroys frames the README GIF still needs.
 */
export function scenesSafeToDelete(encoded: ReadonlySet<string>, targets: readonly EncodeTarget[] = TARGETS): string[] {
  const scenes = [...new Set(targets.map((target) => target.scene))];
  return scenes.filter((scene) => targets.filter((target) => target.scene === scene).every((target) => encoded.has(target.name)));
}

interface SceneCheckpoint {
  readonly name: string;
  readonly segment?: string;
  readonly frame?: number;
}

function sh(command: readonly string[]): void {
  const result = Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} exited ${result.exitCode}`);
}

function readCheckpoints(root: string, scene: string): SceneCheckpoint[] {
  const path = join(root, scene, "scene.json");
  if (!existsSync(path)) throw new Error(`${path} missing: run bun run demo:record --scene ${scene} first`);
  const summary = JSON.parse(readFileSync(path, "utf8")) as { dry: boolean; checkpoints: SceneCheckpoint[] };
  if (summary.dry) throw new Error(`${scene} was recorded with --dry; record it without --dry to encode`);
  return summary.checkpoints;
}

function frameIndex(checkpoints: readonly SceneCheckpoint[], name: string, segment: string): number {
  const checkpoint = checkpoints.find((candidate) => candidate.name === name);
  if (checkpoint?.frame === undefined || checkpoint.segment !== segment) {
    throw new Error(`checkpoint ${name} has no frame in ${segment}`);
  }
  return checkpoint.frame;
}

/**
 * ffmpeg concat list for frames [start, end]: each frame is held until the
 * next one arrived (divided by `speed`), the last one for `holdEnd` seconds.
 * Returns the list path and the clip duration in seconds.
 */
export function writeConcatList(
  frames: readonly Frame[],
  options: {
    readonly start: number;
    readonly end: number;
    readonly speed: number;
    readonly holdEnd: number;
    readonly listPath: string;
    /** Directory the frame file names are relative to. */
    readonly framesDir: string;
  },
): number {
  const selected = frames.slice(options.start, options.end + 1);
  if (selected.length < 2) throw new Error(`need at least two frames, got ${selected.length}`);
  const lines: string[] = [];
  let total = 0;
  // ffmpeg resolves concat entries relative to the list file; keep them relative so no local path is written.
  const quoted = (frame: Frame): string =>
    `file '${relative(dirname(options.listPath), join(options.framesDir, frame.file)).replace(/'/g, "'\\''")}'`;
  selected.forEach((frame, index) => {
    const next = selected[index + 1];
    const duration = next ? Math.max(0.001, (next.timestamp - frame.timestamp) / options.speed) : Math.max(0.001, options.holdEnd);
    total += duration;
    lines.push(quoted(frame), `duration ${duration.toFixed(4)}`);
  });
  lines.push(quoted(selected.at(-1)!));
  writeFileSync(options.listPath, `${lines.join("\n")}\n`);
  return total;
}

interface ProbeResult {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly codec: string;
  readonly pixelFormat: string | undefined;
}

function probe(ffprobe: string, file: string): ProbeResult {
  const result = Bun.spawnSync([ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  if (result.exitCode !== 0) throw new Error(`ffprobe failed for ${file}`);
  const data = JSON.parse(result.stdout.toString()) as {
    streams: Array<{ codec_type: string; codec_name: string; width: number; height: number; pix_fmt?: string }>;
    format: { duration?: string };
  };
  const video = data.streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error(`${file} has no video stream`);
  return { width: video.width, height: video.height, seconds: Number(data.format.duration ?? 0), codec: video.codec_name, pixelFormat: video.pix_fmt };
}

function encodeTarget(ffmpeg: string, ffprobe: string, root: string, target: EncodeTarget): Record<string, unknown> {
  const segment = target.segment ?? "frames";
  const framesDir = join(root, target.scene, segment);
  const framesPath = join(framesDir, "frames.json");
  if (!existsSync(framesPath)) throw new Error(`${framesPath} missing: record ${target.scene} without --dry (or frames were already deleted; re-record)`);
  const frames = JSON.parse(readFileSync(framesPath, "utf8")) as Frame[];
  const checkpoints = target.from || target.to ? readCheckpoints(root, target.scene) : [];
  const start = target.from ? frameIndex(checkpoints, target.from, segment) : 0;
  const end = target.to ? frameIndex(checkpoints, target.to, segment) : frames.length - 1;
  const listPath = join(framesDir, `concat-${target.name}.txt`);
  const seconds = writeConcatList(frames, { start, end, speed: target.speed ?? 1, holdEnd: target.holdEnd ?? 0, listPath, framesDir });
  if (target.maxSeconds !== undefined && seconds > target.maxSeconds) {
    throw new Error(`${target.name}: ${seconds.toFixed(1)} s exceeds the ${target.maxSeconds} s budget; shorten the cut or raise speed`);
  }
  const out = join(root, target.out);
  mkdirSync(dirname(out), { recursive: true });
  const input = ["-f", "concat", "-safe", "0", "-i", listPath];
  const scale = `scale=${target.width}:-2:flags=lanczos`;
  if (target.kind === "mp4") {
    sh([ffmpeg, "-loglevel", "error", "-y", ...input, "-vf", `fps=${target.fps},${scale}`,
      "-c:v", "libx264", "-preset", "slow", "-crf", String(target.crf ?? 23), "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-an", out]);
  } else {
    const palette = join(framesDir, `palette-${target.name}.png`);
    sh([ffmpeg, "-loglevel", "error", "-y", ...input, "-vf", `fps=${target.fps},${scale},palettegen=max_colors=96:stats_mode=diff`, palette]);
    sh([ffmpeg, "-loglevel", "error", "-y", ...input, "-i", palette,
      "-lavfi", `fps=${target.fps},${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", out]);
  }
  const bytes = statSync(out).size;
  const metadata = probe(ffprobe, out);
  if (target.maxBytes !== undefined && bytes > target.maxBytes) {
    throw new Error(`${target.name}: ${bytes} bytes exceeds the ${target.maxBytes} byte budget (${out})`);
  }
  return { target: target.name, out: target.out, bytes, plannedSeconds: Number(seconds.toFixed(2)), ...metadata };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  for (const key of args.keys()) {
    if (!["target", "in", "keep-frames", "list"].includes(key)) throw new Error(`unknown flag --${key}`);
  }
  if (args.get("list") === "true") {
    for (const target of TARGETS) console.log(`${target.name.padEnd(20)} ${target.scene.padEnd(8)} ${target.out}`);
    process.exit(0);
  }
  const root = resolve(args.get("in") ?? DEMO_OUT);
  const requested = args.get("target") ?? "all";
  const targets = requested === "all" ? [...TARGETS] : requested.split(",").map((name) => {
    const target = TARGETS.find((candidate) => candidate.name === name);
    if (!target) throw new Error(`unknown target ${name}; see --list`);
    return target;
  });
  const available = targets.filter((target) => existsSync(join(root, target.scene, target.segment ?? "frames", "frames.json")));
  const skipped = requested === "all" ? targets.filter((target) => !available.includes(target)).map((target) => target.name) : [];
  if (requested !== "all" && available.length !== targets.length) {
    throw new Error(`frames missing for ${targets.filter((target) => !available.includes(target)).map((target) => target.name).join(", ")}`);
  }
  assertFreeDisk(root);
  const ffmpeg = resolveTool(FFMPEG_TOOL);
  const ffprobe = ffprobeFor(ffmpeg);
  const results: Record<string, unknown>[] = [];
  for (const target of available) {
    const result = encodeTarget(ffmpeg, ffprobe, root, target);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const reportPath = join(root, "encode.json");
  writeFileSync(reportPath, `${JSON.stringify({ results, skipped }, null, 2)}\n`);
  if (skipped.length > 0) console.log(`skipped (no frames): ${skipped.join(", ")}`);
  if (args.get("keep-frames") !== "true") {
    const encoded = new Set(available.map((target) => target.name));
    const kept = [...new Set(available.map((target) => target.scene))].filter((scene) => !scenesSafeToDelete(encoded).includes(scene));
    if (kept.length > 0) console.log(`kept frames for ${kept.join(", ")}: not every target reading them was encoded this run`);
    for (const scene of scenesSafeToDelete(encoded)) {
      for (const entry of readdirSync(join(root, scene))) {
        if (entry === "frames" || entry.startsWith("frames-")) rmSync(join(root, scene, entry), { recursive: true, force: true });
      }
      console.log(`deleted ${scene} frames`);
    }
  }
}
