#!/usr/bin/env bun
/**
 * Encodes recorded demo frames (from demo:record) into the site loops, README
 * GIFs and per-scene sources for the promo cut. Needs ffmpeg >= 6 via
 * WOLFPACK_FFMPEG (see CONTRIBUTING.md, "Site and demo media").
 *
 *   bun run demo:encode [--target <name>[,<name>]|all] [--in .demo-out] [--keep-frames] [--install] [--list]
 *                       [--music <file>] [--keep-work]   (promo options)
 *
 * Clip targets cut a frame range between two recorder checkpoints, hold the
 * last frame and optionally speed up; still targets convert a checkpoint
 * screenshot to png or webp. Every target enforces its duration/size budget
 * (a miss fails the run instead of shipping an oversized file). --install
 * copies outputs to their repository paths and re-hashes site/.
 * Results and ffprobe metadata go to <in>/encode.json. A scene's screencast
 * frames are deleted only when every target that reads that scene was encoded
 * in this run (see scenesSafeToDelete), and never with --keep-frames.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { checkSiteAssets, normalizeSiteAssets } from "../site-assets";
import { PROMO_SCENES, PROMO_SEGMENTS, buildPromo } from "./promo";
import { DEMO_OUT, FFMPEG_TOOL, REPOSITORY_ROOT, assertFreeDisk, ffprobeFor, parseArgs, resolveTool, type Frame } from "./lib";

interface TargetBase {
  readonly name: string;
  readonly scene: string;
  /** Output path relative to the demo output root. */
  readonly out: string;
  readonly maxBytes?: number;
  /**
   * Repository paths `--install` copies the output to. Site files use the
   * unhashed `site/assets/<stem>.<ext>` name; site:assets then hashes them,
   * drops the stale sibling and rewrites site/index.html.
   */
  readonly install?: readonly string[];
}

/** A clip cut from screencast frames. */
export interface ClipTarget extends TargetBase {
  readonly kind: "mp4" | "gif";
  /** Screencast segment directory inside the scene (default "frames"). */
  readonly segment?: string;
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
}

/** A still converted from a recorder checkpoint screenshot. */
export interface StillTarget extends TargetBase {
  readonly kind: "png" | "webp";
  readonly checkpoint: string;
  /** webp quality (lossy). */
  readonly quality?: number;
  /** Quantise a png to a 256-colour palette (much smaller for flat UI). */
  readonly palette?: boolean;
}

export type EncodeTarget = ClipTarget | StillTarget;

const MB = 1024 * 1024;
const KB = 1024;

export const TARGETS: readonly EncodeTarget[] = [
  { name: "desktop-source", scene: "desktop", out: "desktop/desktop.mp4", kind: "mp4", width: 1440, fps: 30, crf: 18, holdEnd: 1 },
  { name: "mobile-source", scene: "mobile", out: "mobile/mobile.mp4", kind: "mp4", width: 780, fps: 30, crf: 18, holdEnd: 1 },
  { name: "cli-source", scene: "cli", segment: "frames-cli", out: "cli/cli.mp4", kind: "mp4", width: 1920, fps: 30, crf: 18 },
  ...["title", "privacy", "install", "end"].map((card): EncodeTarget => ({
    name: `card-${card}`, scene: "cards", segment: `frames-${card}`, out: `cards/${card}.mp4`, kind: "mp4", width: 1920, fps: 30, crf: 18,
  })),
  {
    // Starts before the pointer appears, so the first frame equals the desktop-sessions poster.
    name: "hero", scene: "desktop", out: "site/wolfpack-usage-demo.mp4", kind: "mp4",
    to: "s3-grid", holdEnd: 1.2, speed: 1.2, width: 1280, fps: 30, crf: 26, maxSeconds: 22, maxBytes: 1.5 * MB,
    install: ["site/assets/wolfpack-usage-demo.mp4"],
  },
  {
    name: "phone", scene: "mobile", out: "site/wolfpack-mobile-demo.mp4", kind: "mp4",
    from: "s5-dashboard", holdEnd: 1, speed: 1.1, width: 780, fps: 30, crf: 27, maxSeconds: 15, maxBytes: 0.8 * MB,
    install: ["site/assets/wolfpack-mobile-demo.mp4"],
  },
  {
    name: "readme-desktop-gif", scene: "desktop", out: "readme/wolfpack-usage-demo.gif", kind: "gif",
    from: "s1-dashboard", to: "s3-switched", holdEnd: 1.2, speed: 1.2, width: 900, fps: 6, maxSeconds: 15, maxBytes: 2.5 * MB,
    install: ["docs/assets/wolfpack-usage-demo.gif"],
  },
  {
    name: "readme-mobile-gif", scene: "mobile", out: "readme/wolfpack-mobile-demo.gif", kind: "gif",
    from: "s5-dashboard", holdEnd: 1, speed: 1.2, width: 440, fps: 5, maxSeconds: 15, maxBytes: 1.1 * MB,
    install: ["docs/assets/wolfpack-mobile-demo.gif"],
  },
  // Stills (scene "stills"): desktop 1440×900 @1×, phone 390×844 @2× (780×1688 pixels).
  {
    name: "still-desktop-sessions", scene: "stills", checkpoint: "desktop-sessions", kind: "png", out: "site/desktop-sessions.png",
    maxBytes: 250 * KB, install: ["site/assets/desktop-sessions.png", "docs/assets/wolfpack-desktop-dashboard.png"],
  },
  {
    name: "still-desktop-terminal", scene: "stills", checkpoint: "desktop-terminal", kind: "png", out: "site/desktop-terminal.png",
    maxBytes: 280 * KB, install: ["site/assets/desktop-terminal.png"],
  },
  {
    name: "still-mobile-sessions", scene: "stills", checkpoint: "mobile-sessions", kind: "webp", quality: 72, out: "site/mobile-sessions.webp",
    maxBytes: 60 * KB, install: ["site/assets/mobile-sessions.webp"],
  },
  {
    name: "still-mobile-terminal", scene: "stills", checkpoint: "mobile-terminal", kind: "webp", quality: 78, out: "site/mobile-terminal.webp",
    maxBytes: 90 * KB, install: ["site/assets/mobile-terminal.webp"],
  },
  {
    name: "still-docs-mobile-sessions", scene: "stills", checkpoint: "mobile-sessions", kind: "png", palette: true, out: "docs/mobile-sessions.png",
    maxBytes: 300 * KB, install: ["docs/assets/wolfpack-mobile-sessions.png", "docs/mobile-sessions.png"],
  },
  {
    name: "still-docs-mobile-terminal", scene: "stills", checkpoint: "mobile-terminal", kind: "png", palette: true, out: "docs/mobile-ghostty.png",
    maxBytes: 300 * KB, install: ["docs/mobile-ghostty.png"],
  },
  // New stems land in phase 3 with the HTML and registry entries that reference them; staged only.
  ...(["desktop-grid", "desktop-delegation", "desktop-widgets"] as const).map((stem): EncodeTarget => ({
    name: `staged-${stem}`, scene: "stills", checkpoint: stem, kind: "webp", quality: 80, out: `site/staging/${stem}.webp`, maxBytes: 150 * KB,
  })),
  { name: "staged-mobile-drawer", scene: "stills", checkpoint: "mobile-drawer", kind: "webp", quality: 78, out: "site/staging/mobile-drawer.webp", maxBytes: 90 * KB },
];

function isClip(target: EncodeTarget): target is ClipTarget {
  return target.kind === "mp4" || target.kind === "gif";
}

/**
 * Scenes whose frames may be deleted after a run: every target that reads the
 * scene must have been encoded in that run (including the promo for the
 * scenes it reads), so a single `--target hero` never destroys frames the
 * README GIF or the promo still need.
 */
export function scenesSafeToDelete(
  encoded: ReadonlySet<string>,
  targets: readonly EncodeTarget[] = TARGETS,
  promoScenes: readonly string[] = PROMO_SCENES,
): string[] {
  const clips = targets.filter(isClip);
  const scenes = [...new Set(clips.map((target) => target.scene))];
  return scenes.filter((scene) => clips.filter((target) => target.scene === scene).every((target) => encoded.has(target.name))
    && (!promoScenes.includes(scene) || encoded.has(PROMO_TARGET)));
}

/** The promo long cut reads several scenes' frames; built by scripts/demo/promo.ts. */
export const PROMO_TARGET = "promo";

export interface SceneCheckpoint {
  readonly name: string;
  readonly segment?: string;
  readonly frame?: number;
}

export function sh(command: readonly string[]): void {
  const result = Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} exited ${result.exitCode}`);
}

export function readCheckpoints(root: string, scene: string): SceneCheckpoint[] {
  const path = join(root, scene, "scene.json");
  if (!existsSync(path)) throw new Error(`${path} missing: run bun run demo:record --scene ${scene} first`);
  const summary = JSON.parse(readFileSync(path, "utf8")) as { dry: boolean; checkpoints: SceneCheckpoint[] };
  if (summary.dry) throw new Error(`${scene} was recorded with --dry; record it without --dry to encode`);
  return summary.checkpoints;
}

/**
 * Index of the frame on screen when a checkpoint was taken. The recorder
 * stores how many frames had arrived; the screencast only emits on change,
 * so the picture on screen is the last one received, not the next one.
 */
export function frameIndex(checkpoints: readonly SceneCheckpoint[], name: string, segment: string): number {
  const checkpoint = checkpoints.find((candidate) => candidate.name === name);
  if (checkpoint?.frame === undefined || checkpoint.segment !== segment) {
    throw new Error(`checkpoint ${name} has no frame in ${segment}`);
  }
  return Math.max(0, checkpoint.frame - 1);
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

export interface ProbeResult {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly codec: string;
  readonly pixelFormat: string | undefined;
}

export function probe(ffprobe: string, file: string): ProbeResult {
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

function checkpointFile(root: string, scene: string, name: string): string {
  const path = join(root, scene, "scene.json");
  if (!existsSync(path)) throw new Error(`${path} missing: run bun run demo:record --scene ${scene} first`);
  const summary = JSON.parse(readFileSync(path, "utf8")) as { checkpoints: Array<{ name: string; file: string }> };
  const checkpoint = summary.checkpoints.find((candidate) => candidate.name === name);
  if (!checkpoint) throw new Error(`${scene} has no checkpoint ${name}`);
  return join(root, scene, checkpoint.file);
}

function encodeStill(ffmpeg: string, ffprobe: string, root: string, target: StillTarget): Record<string, unknown> {
  const source = checkpointFile(root, target.scene, target.checkpoint);
  const out = join(root, target.out);
  mkdirSync(dirname(out), { recursive: true });
  if (target.kind === "webp") {
    sh([ffmpeg, "-loglevel", "error", "-y", "-i", source, "-c:v", "libwebp", "-quality", String(target.quality ?? 80),
      "-compression_level", "6", "-preset", "picture", out]);
  } else if (target.palette) {
    sh([ffmpeg, "-loglevel", "error", "-y", "-i", source, "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none",
      "-pred", "mixed", "-compression_level", "9", out]);
  } else {
    sh([ffmpeg, "-loglevel", "error", "-y", "-i", source, "-pred", "mixed", "-compression_level", "9", out]);
  }
  const bytes = statSync(out).size;
  const metadata = probe(ffprobe, out);
  if (target.maxBytes !== undefined && bytes > target.maxBytes) {
    throw new Error(`${target.name}: ${bytes} bytes exceeds the ${target.maxBytes} byte budget (${out})`);
  }
  return { target: target.name, out: target.out, bytes, ...metadata };
}

function encodeTarget(ffmpeg: string, ffprobe: string, root: string, target: EncodeTarget): Record<string, unknown> {
  return isClip(target) ? encodeClip(ffmpeg, ffprobe, root, target) : encodeStill(ffmpeg, ffprobe, root, target);
}

function encodeClip(ffmpeg: string, ffprobe: string, root: string, target: ClipTarget): Record<string, unknown> {
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

/**
 * Promo outputs `--install` copies when the promo is built in the same run:
 * the site's tour player gets the captions-only cut and its poster. The
 * social and music cuts stay in .demo-out/promo/.
 */
export const PROMO_INSTALL: readonly Pick<TargetBase, "out" | "install" | "maxBytes">[] = [
  // Site budget for the tour; PROMO_MAX_BYTES only bounds the uncommitted long cut.
  { out: "promo/wolfpack-tour.mp4", install: ["site/assets/wolfpack-tour.mp4"], maxBytes: 4 * MB },
  { out: "promo/poster.webp", install: ["site/assets/wolfpack-tour-poster.webp"] },
];

/**
 * Copies encoded outputs to their repository paths, then normalises site/
 * (content hashes, stale siblings, index.html references) and fails on any
 * site:check finding, so an install never leaves the site half-renamed.
 */
/** Throws before anything is copied when an output to install exceeds its byte budget. */
export function assertInstallBudgets(root: string, entries: readonly Pick<TargetBase, "out" | "install" | "maxBytes">[]): void {
  for (const { out, install, maxBytes } of entries) {
    if (!install?.length || maxBytes === undefined) continue;
    const bytes = statSync(join(root, out)).size;
    if (bytes > maxBytes) throw new Error(`${out}: ${bytes} bytes exceeds its ${maxBytes} byte install budget`);
  }
}

function installOutputs(root: string, encoded: readonly Pick<TargetBase, "out" | "install" | "maxBytes">[]): void {
  assertInstallBudgets(root, encoded);
  let site = false;
  for (const target of encoded) {
    for (const destination of target.install ?? []) {
      const path = join(REPOSITORY_ROOT, destination);
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(join(root, target.out), path);
      console.log(`installed ${target.out} -> ${destination}`);
      if (destination.startsWith("site/")) site = true;
    }
  }
  if (!site) return;
  const siteRoot = join(REPOSITORY_ROOT, "site");
  const result = normalizeSiteAssets(siteRoot);
  for (const { from, to } of result.renamed) console.log(`renamed site/${from} -> site/${to}`);
  for (const path of result.removed) console.log(`removed site/${path}`);
  const errors = checkSiteAssets(siteRoot, { gitRoot: REPOSITORY_ROOT });
  if (errors.length > 0) throw new Error(`site:check after install:\n${errors.join("\n")}`);
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  for (const key of args.keys()) {
    if (!["target", "in", "keep-frames", "list", "install", "music", "keep-work"].includes(key)) throw new Error(`unknown flag --${key}`);
  }
  if (args.get("list") === "true") {
    for (const target of TARGETS) console.log(`${target.name.padEnd(28)} ${target.scene.padEnd(8)} ${target.out}`);
    console.log(`${PROMO_TARGET.padEnd(28)} ${PROMO_SCENES.join("+")} promo/wolfpack-tour.mp4 (+ .vtt, social, poster; --music <file>)`);
    process.exit(0);
  }
  const root = resolve(args.get("in") ?? DEMO_OUT);
  const requested = args.get("target") ?? "all";
  const requestedNames = requested === "all" ? [...TARGETS.map((target) => target.name), PROMO_TARGET] : requested.split(",");
  const promoInputs = PROMO_SEGMENTS.every((segment) => existsSync(join(root, segment.scene, segment.segment ?? "frames", "frames.json")));
  const wantPromo = requestedNames.includes(PROMO_TARGET) && (requested !== "all" || promoInputs);
  if (wantPromo && !promoInputs) throw new Error("inputs missing for promo: record desktop, mobile, cli and cards without --dry");
  const targets = requested === "all" ? [...TARGETS] : requestedNames.filter((name) => name !== PROMO_TARGET).map((name) => {
    const target = TARGETS.find((candidate) => candidate.name === name);
    if (!target) throw new Error(`unknown target ${name}; see --list`);
    return target;
  });
  const hasInput = (target: EncodeTarget): boolean => isClip(target)
    ? existsSync(join(root, target.scene, target.segment ?? "frames", "frames.json"))
    : existsSync(join(root, target.scene, "scene.json"));
  const available = targets.filter(hasInput);
  const skipped = requested === "all" ? targets.filter((target) => !available.includes(target)).map((target) => target.name) : [];
  if (requested !== "all" && available.length !== targets.length) {
    throw new Error(`inputs missing for ${targets.filter((target) => !available.includes(target)).map((target) => target.name).join(", ")}`);
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
  if (wantPromo) {
    const music = args.get("music");
    if (music !== undefined && !existsSync(music)) throw new Error(`--music ${music} does not exist`);
    const promo = await buildPromo({
      root,
      ffmpeg,
      ffprobe,
      keepWork: args.get("keep-work") === "true",
      music,
    });
    for (const result of promo) {
      results.push(result);
      console.log(JSON.stringify({ ...result, timeline: undefined }));
    }
  } else if (requested === "all") {
    skipped.push(PROMO_TARGET);
  }
  const reportPath = join(root, "encode.json");
  writeFileSync(reportPath, `${JSON.stringify({ results, skipped }, null, 2)}\n`);
  if (skipped.length > 0) console.log(`skipped (no recorded input): ${skipped.join(", ")}`);
  if (args.get("install") === "true") installOutputs(root, [...available, ...(wantPromo ? PROMO_INSTALL : [])]);
  if (args.get("keep-frames") !== "true") {
    const encoded = new Set([...available.map((target) => target.name), ...(wantPromo ? [PROMO_TARGET] : [])]);
    const kept = [...new Set(available.filter(isClip).map((target) => target.scene))].filter((scene) => !scenesSafeToDelete(encoded).includes(scene));
    if (kept.length > 0) console.log(`kept frames for ${kept.join(", ")}: not every target reading them was encoded this run`);
    for (const scene of scenesSafeToDelete(encoded)) {
      for (const entry of readdirSync(join(root, scene))) {
        if (entry === "frames" || entry.startsWith("frames-")) rmSync(join(root, scene, entry), { recursive: true, force: true });
      }
      console.log(`deleted ${scene} frames`);
    }
  }
}
