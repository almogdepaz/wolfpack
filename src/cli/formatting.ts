/**
 * Terminal formatting helpers — WOLF ascii art, color functions, and output policy.
 */

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

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export const WOLF = `
        ...:.
           :=+=:
       . .-*####+-
      .- :++**####*=.
       -  :+***#####*=:.
       :   .+**######*+==++++++=:..
       ..   .=*#######*++++====+=--=-.
       .:.-    -+**######**+*#*+=-:-===:
     -.  ..     -++++***#**++*#*--:---===:
     -.:--==+=--=*++*+**********+==------++-
     .:----=++*++##########******+=====--=+#=-.
       .::-----=++*#%%%%%%#***###*+===--==+*=++=:.
         ...::::-=+*#%%############*+-----===+****+=:.
          :--=-====+******++****##***-.::--++*######**
         .++-+++++***********#*+*#***=.:---=+**=--=+==
         -**++*++****+***##*++*****++=. ----=+=.  ..:-
        .+##***+*+*****##*#=-=**=-=-::. -**-::-==+++++
        :*%%*+=+=+****##**++****+**+-.. -*=-   .::::-=
        .-#%#*+*+**#***+++**+****+*++=--+=::-:..:...-+
         =###***=*+++++-=*=+++++-====-=:-=--:=---==---
        .:-+***+=*+++**+++===*++++=--:=  ::=::-=----++
          .+****+++++*##+***++=+*-.:--:..-===---=-:-++
          .-+###**+++*#****+=---:--==.--=:==-==:::-=++
            :####*****+++======:.. :...:::---:.=------
            .=###***+++*++++--:.:::.   :-=::.:..-:---:
             :+**++++++*++*+=-:: .. ...... ..   .:..::
`;

export function bold(value: string): string {
  return `\x1b[1m${value}\x1b[0m`;
}

export function green(value: string): string {
  return `\x1b[32m${value}\x1b[0m`;
}

export function red(value: string): string {
  return `\x1b[31m${value}\x1b[0m`;
}

export function dim(value: string): string {
  return `\x1b[2m${value}\x1b[0m`;
}

export function yellow(value: string): string {
  return `\x1b[33m${value}\x1b[0m`;
}
