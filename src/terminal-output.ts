/** Terminal output and color policy shared by CLI and credential diagnostics. */
interface CliWritable {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

const ANSI_STYLE_PATTERN = /\x1b\[[0-9;]*m/g;

export function shouldUseColor(
  stream: Pick<CliWritable, "isTTY">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR")) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined) return true;
  if (env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

function writeLine(stream: CliWritable, message: string): void {
  const rendered = shouldUseColor(stream) ? message : message.replace(ANSI_STYLE_PATTERN, "");
  stream.write(`${rendered}\n`);
}

export function print(message: string): void {
  writeLine(process.stdout, message);
}

export function printError(message: string): void {
  writeLine(process.stderr, message);
}

export function yellow(value: string): string {
  return `\x1b[33m${value}\x1b[0m`;
}
