/**
 * Strip ANSI escape codes and terminal control sequences from text.
 */

// CSI sequences: ESC [ ... final_byte
// OSC sequences: ESC ] ... BEL or ESC ] ... ST
// Other escape sequences: ESC ( or ESC ) followed by character
const ANSI_RE =
  /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B\][^\x1B]*\x1B\\|\x1B[()][AB012]/g;

// Carriage return without newline (spinner/progress line overwrites)
const CR_OVERWRITE_RE = /\r(?!\n)[^\n]*/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(CR_OVERWRITE_RE, "");
}
