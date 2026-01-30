/**
 * Minimal QR code generator for terminal output.
 * Uses unicode block characters to render a scannable QR code.
 * Supports up to ~90 chars (alphanumeric URL).
 */

// QR encoding is complex — shell out to a tiny inline python script
// since python3 ships on macOS and most Linux. Falls back to URL-only.

import { execSync } from "node:child_process";

export function printQR(url: string): void {
  // Try python3 with qrcode module first, then segno, then fallback
  const script = `
import sys
try:
    import qrcode
    qr = qrcode.QRCode(box_size=1, border=1)
    qr.add_data(sys.argv[1])
    qr.make(fit=True)
    matrix = qr.get_matrix()
except ImportError:
    try:
        import segno
        qr = segno.make(sys.argv[1])
        matrix = []
        for row in qr.matrix:
            matrix.append([bool(c) for c in row])
    except ImportError:
        # Manual minimal encoding — just print URL
        print("__NO_QR__")
        sys.exit(0)

# Render using upper/lower half block chars (2 rows per line)
lines = []
rows = len(matrix)
for y in range(0, rows, 2):
    line = ""
    for x in range(len(matrix[0])):
        top = matrix[y][x] if y < rows else False
        bot = matrix[y+1][x] if y+1 < rows else False
        if top and bot:
            line += "\\u2588"   # full block
        elif top:
            line += "\\u2580"   # upper half
        elif bot:
            line += "\\u2584"   # lower half
        else:
            line += " "
    lines.append(line)

for l in lines:
    print("    " + l)
`;

  try {
    const result = execSync(
      `python3 -c ${JSON.stringify(script)} ${JSON.stringify(url)}`,
      {
        encoding: "utf-8",
        timeout: 5000,
      },
    );

    if (result.includes("__NO_QR__")) {
      // No QR library — install qrcode and retry once
      try {
        execSync("python3 -m pip install --quiet qrcode 2>/dev/null", {
          timeout: 15000,
        });
        const retry = execSync(
          `python3 -c ${JSON.stringify(script)} ${JSON.stringify(url)}`,
          {
            encoding: "utf-8",
            timeout: 5000,
          },
        );
        if (!retry.includes("__NO_QR__")) {
          console.log(retry);
          return;
        }
      } catch {}
      // Give up on QR
      return;
    }

    console.log(result);
  } catch {
    // python3 not available or failed — skip QR silently
  }
}
