/**
 * Promo long cut (scenes S0–S8 of .plans/site-overhaul.md §1): cuts each scene
 * from the recorded frames, composes it on a 1920×1080 canvas (desktop window
 * chrome, or a phone bezel over a blurred dashboard), overlays the scene's
 * caption from captions.vtt as a browser-rendered PNG, joins the scenes with
 * crossfades and writes a sidecar VTT from the real timeline.
 *
 * Outputs in <root>/promo/: wolfpack-tour.mp4 (captions burned in, no audio),
 * wolfpack-tour.vtt, wolfpack-tour-social.mp4 (1280×720), poster.webp and
 * contact-sheet.png; with a voiceover or music, wolfpack-tour-voiceover.mp4
 * mixed to −18 LUFS. Nothing here is committed.
 */
import { chromium, type Browser } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { frameIndex, probe, readCheckpoints, sh, writeConcatList } from "./encode";
import type { Frame, ToolSpec } from "./lib";
import { assertClean, forbiddenStrings } from "./privacy-gate";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const CROSSFADE_SECONDS = 0.5;
const CAPTION_TOP = 960;
const CARDS_DIR = join(import.meta.dirname, "cards");
const CAPTIONS_PATH = join(import.meta.dirname, "captions.vtt");
const MB = 1024 * 1024;
export const PROMO_MAX_BYTES = 20 * MB;
export const SOCIAL_MAX_BYTES = 8 * MB;
export const TARGET_LUFS = -18;

/** Geometry shared with cards/canvas.html. */
const DESKTOP_RECT = { x: 240, y: 58, width: 1440, height: 900 } as const;
const PHONE_RECT = { x: 756, y: 40, width: 408, height: 884 } as const;

export const PIPER_TOOL: ToolSpec = {
  env: "WOLFPACK_PIPER",
  name: "the piper TTS binary (upstream standalone release)",
  hint: "unpack https://github.com/rhasspy/piper/releases under ~/.local/opt/ and export WOLFPACK_PIPER=~/.local/opt/piper/piper",
};
export const PIPER_VOICE_TOOL: ToolSpec = {
  env: "WOLFPACK_PIPER_VOICE",
  name: "a piper voice model (.onnx with its .onnx.json beside it)",
  hint: "download one from https://huggingface.co/rhasspy/piper-voices and export WOLFPACK_PIPER_VOICE=<path>.onnx",
};

type Layout = "full" | "desktop" | "phone";

export interface PromoSegment {
  readonly id: string;
  /** Cue id in captions.vtt, or null for no caption (end card). */
  readonly caption: string | null;
  readonly layout: Layout;
  readonly scene: string;
  readonly segment?: string;
  readonly from?: string;
  readonly to?: string;
  /** Seconds the last frame is held. */
  readonly holdEnd?: number;
  /** The scene is padded (last frame held) to at least this long. */
  readonly minSeconds?: number;
}

export const PROMO_SEGMENTS: readonly PromoSegment[] = [
  { id: "s0-title", caption: "s0", layout: "full", scene: "cards", segment: "frames-title", minSeconds: 5.5 },
  { id: "s1-dashboard", caption: "s1", layout: "desktop", scene: "desktop", to: "s2-start", minSeconds: 5.5 },
  { id: "s2-answer", caption: "s2", layout: "desktop", scene: "desktop", from: "s2-start", to: "s3-start", holdEnd: 0.6 },
  { id: "s3-switch-grid", caption: "s3", layout: "desktop", scene: "desktop", from: "s3-start", to: "s4-start", holdEnd: 0.4 },
  { id: "s4-delegation", caption: "s4", layout: "desktop", scene: "desktop", from: "s4-start", holdEnd: 1.5, minSeconds: 7 },
  { id: "s5-phone", caption: "s5", layout: "phone", scene: "mobile", holdEnd: 1, minSeconds: 12 },
  { id: "s6-cli", caption: "s6", layout: "full", scene: "cli", segment: "frames-cli", minSeconds: 13.5 },
  { id: "s7-privacy", caption: "s7", layout: "full", scene: "cards", segment: "frames-privacy", minSeconds: 8.5 },
  { id: "s8-install", caption: "s8", layout: "full", scene: "cards", segment: "frames-install", minSeconds: 7.5 },
  { id: "end", caption: null, layout: "full", scene: "cards", segment: "frames-end", minSeconds: 5 },
];

/** Scenes whose screencast frames the promo reads. */
export const PROMO_SCENES = [...new Set(PROMO_SEGMENTS.map((segment) => segment.scene))];

/** Spoken lines for the optional voiceover; captions are the default and stay burned in. */
const NARRATION: Readonly<Record<string, string>> = {
  s0: "Wolfpack. A self-hosted control room for coding agents.",
  s8: "Install it with one command, then open it on your phone.",
};

export interface Cue {
  readonly id: string;
  readonly text: string;
}

/** Cue ids and texts from a WebVTT file (timings are recomputed from the cut). */
export function parseCues(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 1) continue;
    cues.push({ id: lines[timing - 1]!.trim(), text: lines.slice(timing + 1).join(" ").trim() });
  }
  return cues;
}

export function formatVttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * Start offsets of crossfaded segments: each starts CROSSFADE_SECONDS before
 * the previous one ends. Returns starts and the total length.
 */
export function crossfadeTimeline(durations: readonly number[], crossfade = CROSSFADE_SECONDS): { starts: number[]; total: number } {
  const starts: number[] = [];
  let cursor = 0;
  durations.forEach((duration, index) => {
    starts.push(index === 0 ? 0 : cursor - crossfade);
    cursor = starts[index]! + duration;
  });
  return { starts, total: cursor };
}

/** Sidecar captions aligned to the assembled cut, inset so cues never overlap across a crossfade. */
export function buildVtt(segments: readonly { caption: string | null; start: number; duration: number }[], cues: readonly Cue[]): string {
  const lines = ["WEBVTT", ""];
  for (const segment of segments) {
    if (!segment.caption) continue;
    const cue = cues.find((candidate) => candidate.id === segment.caption);
    if (!cue) throw new Error(`captions.vtt has no cue ${segment.caption}`);
    lines.push(cue.id, `${formatVttTime(segment.start + 0.25)} --> ${formatVttTime(segment.start + segment.duration - 0.3)}`, cue.text, "");
  }
  return lines.join("\n");
}

interface Overlays {
  readonly base: Record<Exclude<Layout, "full">, string>;
  readonly top: Record<Exclude<Layout, "full">, string>;
  readonly captions: Record<string, string>;
}

async function renderPage(browser: Browser, url: string, size: { width: number; height: number }, out: string, transparent: boolean, forbidden: readonly string[]): Promise<void> {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.locator("body[data-done]").waitFor({ timeout: 20_000 });
    assertClean(await page.evaluate(() => document.documentElement.outerHTML), `promo overlay ${out}`, forbidden);
    await page.screenshot({ path: out, omitBackground: transparent });
  } finally {
    await page.close();
  }
}

async function renderOverlays(root: string, work: string, cues: readonly Cue[], forbidden: readonly string[]): Promise<Overlays> {
  const browser = await chromium.launch();
  try {
    const canvas = pathToFileURL(join(CARDS_DIR, "canvas.html")).href;
    const dashboard = join(root, "stills", "checkpoints", "01-desktop-sessions.png");
    // Relative to cards/, so no local path ends up in the page (the privacy gate checks the DOM).
    const bg = existsSync(dashboard) ? `&bg=${encodeURIComponent(relative(CARDS_DIR, dashboard).split(sep).join("/"))}` : "";
    const overlays: Overlays = { base: { desktop: "", phone: "" }, top: { desktop: "", phone: "" }, captions: {} };
    for (const layout of ["desktop", "phone"] as const) {
      overlays.base[layout] = join(work, `canvas-${layout}-base.png`);
      overlays.top[layout] = join(work, `canvas-${layout}-top.png`);
      await renderPage(browser, `${canvas}?layout=${layout}&layer=base${bg}`, { width: WIDTH, height: HEIGHT }, overlays.base[layout], false, forbidden);
      await renderPage(browser, `${canvas}?layout=${layout}&layer=top`, { width: WIDTH, height: HEIGHT }, overlays.top[layout], true, forbidden);
    }
    const captionPage = pathToFileURL(join(CARDS_DIR, "caption.html")).href;
    for (const cue of cues) {
      overlays.captions[cue.id] = join(work, `caption-${cue.id}.png`);
      await renderPage(browser, `${captionPage}?text=${encodeURIComponent(cue.text)}`, { width: WIDTH, height: HEIGHT - CAPTION_TOP }, overlays.captions[cue.id]!, true, forbidden);
    }
    return overlays;
  } finally {
    await browser.close();
  }
}

/** Writes the segment's concat list; returns its duration after holds and padding. */
function cutSegment(root: string, segment: PromoSegment, listPath: string): number {
  const segmentDir = segment.segment ?? "frames";
  const framesDir = join(root, segment.scene, segmentDir);
  const framesPath = join(framesDir, "frames.json");
  if (!existsSync(framesPath)) throw new Error(`${framesPath} missing: record ${segment.scene} without --dry first`);
  const frames = JSON.parse(readFileSync(framesPath, "utf8")) as Frame[];
  const checkpoints = segment.from || segment.to ? readCheckpoints(root, segment.scene) : [];
  const start = segment.from ? frameIndex(checkpoints, segment.from, segmentDir) : 0;
  const end = segment.to ? frameIndex(checkpoints, segment.to, segmentDir) : frames.length - 1;
  const options = { start, end, speed: 1, holdEnd: segment.holdEnd ?? 0, listPath, framesDir };
  const natural = writeConcatList(frames, options);
  if (segment.minSeconds === undefined || natural >= segment.minSeconds) return natural;
  return writeConcatList(frames, { ...options, holdEnd: options.holdEnd + segment.minSeconds - natural });
}

function composeSegment(ffmpeg: string, segment: PromoSegment, listPath: string, duration: number, overlays: Overlays, out: string): void {
  const inputs = ["-f", "concat", "-safe", "0", "-i", listPath];
  const still = (file: string): string[] => ["-loop", "1", "-framerate", String(FPS), "-t", duration.toFixed(3), "-i", file];
  const filters: string[] = [];
  let last: string;
  if (segment.layout === "full") {
    filters.push(`[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,setsar=1[v]`);
    last = "v";
  } else {
    const rect = segment.layout === "desktop" ? DESKTOP_RECT : PHONE_RECT;
    inputs.push(...still(overlays.base[segment.layout]), ...still(overlays.top[segment.layout]));
    filters.push(
      `[0:v]fps=${FPS},scale=${rect.width}:${rect.height}:flags=lanczos,setsar=1[vid]`,
      `[1:v][vid]overlay=${rect.x}:${rect.y}:shortest=1[a]`,
      "[a][2:v]overlay=0:0[v]",
    );
    last = "v";
  }
  if (segment.caption) {
    const index = inputs.filter((value) => value === "-i").length;
    inputs.push(...still(overlays.captions[segment.caption]!));
    filters.push(
      `[${index}:v]format=rgba,fade=t=in:st=0.2:d=0.35:alpha=1,fade=t=out:st=${Math.max(0.6, duration - 0.6).toFixed(3)}:d=0.35:alpha=1[cap]`,
      `[${last}][cap]overlay=0:${CAPTION_TOP}:shortest=1[c]`,
    );
    last = "c";
  }
  filters.push(`[${last}]format=yuv420p[out]`);
  sh([ffmpeg, "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]",
    "-t", duration.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "fast", "-crf", "14", "-an", out]);
}

function joinSegments(ffmpeg: string, files: readonly string[], durations: readonly number[], out: string, crf: number): number {
  const { starts, total } = crossfadeTimeline(durations);
  const inputs = files.flatMap((file) => ["-i", file]);
  const filters: string[] = [];
  let previous = "0:v";
  for (let index = 1; index < files.length; index += 1) {
    const label = index === files.length - 1 ? "joined" : `x${index}`;
    filters.push(`[${previous}][${index}:v]xfade=transition=fade:duration=${CROSSFADE_SECONDS}:offset=${starts[index]!.toFixed(3)}[${label}]`);
    previous = label;
  }
  filters.push("[joined]format=yuv420p[out]");
  sh([ffmpeg, "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]",
    "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out]);
  return total;
}

/** Integrated loudness (LUFS) of a file's audio, measured with ebur128. */
export function integratedLoudness(ffmpeg: string, file: string): number {
  const result = Bun.spawnSync([ffmpeg, "-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  const output = result.stderr.toString();
  const match = [...output.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)].at(-1);
  if (!match) throw new Error(`no loudness reading for ${file}`);
  return Number(match[1]);
}

function audioSeconds(ffprobe: string, file: string): number {
  const result = Bun.spawnSync([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(result.stdout.toString().trim());
}

interface AudioOptions {
  readonly voice?: { readonly piper: string; readonly model: string };
  readonly music?: string;
}

/**
 * Builds the optional soundtrack (voiceover lines placed at their scene
 * starts, optional music bed underneath) normalised to TARGET_LUFS, and muxes
 * it onto the captioned master. Fails if a spoken line is longer than its scene.
 */
function buildSoundtrack(ffmpeg: string, ffprobe: string, work: string, master: string, total: number,
  timeline: readonly { caption: string | null; start: number; duration: number }[], cues: readonly Cue[], audio: AudioOptions, out: string): Record<string, unknown> {
  const inputs: string[] = [];
  const filters: string[] = [];
  const voiceLabels: string[] = [];
  if (audio.voice) {
    for (const segment of timeline) {
      if (!segment.caption) continue;
      const text = NARRATION[segment.caption] ?? cues.find((cue) => cue.id === segment.caption)!.text.replace(/\s+—\s+/g, ", ");
      const wav = join(work, `voice-${segment.caption}.wav`);
      const piper = Bun.spawnSync([audio.voice.piper, "--model", audio.voice.model, "--output_file", wav, "--sentence_silence", "0.3"], { stdin: Buffer.from(text) });
      if (piper.exitCode !== 0 || !existsSync(wav)) throw new Error(`piper failed for ${segment.caption}: ${piper.stderr.toString().slice(-400)}`);
      const spoken = audioSeconds(ffprobe, wav);
      if (spoken > segment.duration - 0.6) {
        throw new Error(`voiceover ${segment.caption} is ${spoken.toFixed(1)} s but its scene is ${segment.duration.toFixed(1)} s; raise minSeconds`);
      }
      const delay = Math.round((segment.start + 0.35) * 1000);
      const index = inputs.filter((value) => value === "-i").length;
      inputs.push("-i", wav);
      filters.push(`[${index}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[v${index}]`);
      voiceLabels.push(`[v${index}]`);
    }
  }
  let bed = "";
  if (audio.music) {
    const index = inputs.filter((value) => value === "-i").length;
    inputs.push("-stream_loop", "-1", "-i", audio.music);
    const level = voiceLabels.length ? "volume=-16dB," : "";
    filters.push(`[${index}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},${level}afade=t=in:d=1.5,afade=t=out:st=${(total - 2.5).toFixed(3)}:d=2.5[bed]`);
    bed = "[bed]";
  }
  const sources = [...voiceLabels, bed].filter(Boolean);
  if (sources.length === 0) throw new Error("soundtrack requested without voiceover or music");
  filters.push(`${sources.join("")}amix=inputs=${sources.length}:normalize=0:duration=longest,apad,atrim=0:${total.toFixed(3)}[mix]`);
  const mix = join(work, "mix.wav");
  sh([ffmpeg, "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[mix]", "-ar", "48000", mix]);
  // Two-pass loudnorm: measure, then apply linear gain to TARGET_LUFS.
  const measure = Bun.spawnSync([ffmpeg, "-hide_banner", "-nostats", "-i", mix, "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"]);
  const stats = JSON.parse(/\{[\s\S]*\}/.exec(measure.stderr.toString())![0]) as Record<string, string>;
  const normalised = join(work, "mix-normalised.wav");
  sh([ffmpeg, "-loglevel", "error", "-y", "-i", mix, "-af",
    `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`,
    "-ar", "48000", normalised]);
  sh([ffmpeg, "-loglevel", "error", "-y", "-i", master, "-i", normalised, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out]);
  return { loudnessLufs: integratedLoudness(ffmpeg, out), voiceover: Boolean(audio.voice), music: audio.music ? "supplied" : "none" };
}

export interface PromoOptions {
  readonly root: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly audio?: AudioOptions;
  readonly keepWork?: boolean;
  readonly contactSheet?: string;
}

export async function buildPromo(options: PromoOptions): Promise<Record<string, unknown>[]> {
  const { root, ffmpeg, ffprobe } = options;
  const outDir = join(root, "promo");
  const work = join(outDir, "work");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const forbidden = forbiddenStrings();
  const cues = parseCues(readFileSync(CAPTIONS_PATH, "utf8"));
  const overlays = await renderOverlays(root, work, cues, forbidden);

  const files: string[] = [];
  const durations: number[] = [];
  for (const segment of PROMO_SEGMENTS) {
    const listPath = join(work, `${segment.id}.txt`);
    const duration = cutSegment(root, segment, listPath);
    const file = join(work, `${segment.id}.mp4`);
    composeSegment(ffmpeg, segment, listPath, duration, overlays, file);
    files.push(file);
    durations.push(duration);
  }
  const master = join(outDir, "wolfpack-tour.mp4");
  const total = joinSegments(ffmpeg, files, durations, master, 20);
  const { starts } = crossfadeTimeline(durations);
  const timeline = PROMO_SEGMENTS.map((segment, index) => ({ id: segment.id, caption: segment.caption, start: starts[index]!, duration: durations[index]! }));
  const vtt = buildVtt(timeline, cues);
  assertClean(vtt, "promo captions", forbidden);
  writeFileSync(join(outDir, "wolfpack-tour.vtt"), vtt);

  const social = join(outDir, "wolfpack-tour-social.mp4");
  sh([ffmpeg, "-loglevel", "error", "-y", "-i", master, "-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "23",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", social]);
  sh([ffmpeg, "-loglevel", "error", "-y", "-ss", "3", "-i", master, "-frames:v", "1", "-c:v", "libwebp", "-quality", "82", join(outDir, "poster.webp")]);
  const sheet = join(outDir, "contact-sheet.png");
  sh([ffmpeg, "-loglevel", "error", "-y", "-i", master, "-vf", "fps=1/8,scale=480:-1,tile=4x3:padding=6:color=0x0b0e0c", "-frames:v", "1", sheet]);
  if (options.contactSheet) sh([ffmpeg, "-loglevel", "error", "-y", "-i", sheet, options.contactSheet]);

  const results: Record<string, unknown>[] = [];
  const describe = (name: string, file: string, maxBytes: number, extra: Record<string, unknown> = {}): void => {
    const bytes = statSync(file).size;
    if (bytes > maxBytes) throw new Error(`${name}: ${bytes} bytes exceeds the ${maxBytes} byte budget`);
    results.push({ target: name, out: file.slice(root.length + 1), bytes, ...probe(ffprobe, file), ...extra });
  };
  describe("promo", master, PROMO_MAX_BYTES, { plannedSeconds: Number(total.toFixed(2)), timeline: timeline.map((entry) => ({ ...entry, start: Number(entry.start.toFixed(2)), duration: Number(entry.duration.toFixed(2)) })) });
  describe("promo-social", social, SOCIAL_MAX_BYTES);
  if (options.audio && (options.audio.voice || options.audio.music)) {
    const voiced = join(outDir, "wolfpack-tour-voiceover.mp4");
    const soundtrack = buildSoundtrack(ffmpeg, ffprobe, work, master, total, timeline, cues, options.audio, voiced);
    describe("promo-voiceover", voiced, PROMO_MAX_BYTES, soundtrack);
  }
  if (!options.keepWork) rmSync(work, { recursive: true, force: true });
  return results;
}
