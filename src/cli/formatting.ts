/**
 * Terminal formatting helpers — WOLF ascii art, color functions, and output policy.
 */
import type { VerifiedMachineTarget } from "./machine-target.js";

export { shouldUseColor, print, printError, yellow } from "../terminal-output.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printApiJson(value: unknown, target?: VerifiedMachineTarget): void {
  if (target && value && typeof value === "object" && !Array.isArray(value)) {
    printJson({ ...value, machine: target.machine });
    return;
  }
  printJson(value);
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
