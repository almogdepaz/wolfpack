import qr from "qrcode-terminal";

export function printQR(url: string): void {
  qr.generate(url, { small: true }, (code: string) => {
    for (const line of code.split("\n")) {
      console.log("    " + line);
    }
  });
}
