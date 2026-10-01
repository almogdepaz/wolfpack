import { printQR } from "../qr.js";
import { bold, dim, print } from "./formatting.js";

export function printAccessUrls(port: number, remoteUrl: string | null): void {
  if (remoteUrl) {
    print(dim("  Scan the verified remote URL to open Wolfpack on your phone:"));
    print("");
    printQR(remoteUrl);
    print(`  Remote: ${bold(remoteUrl)}`);
  }
  print(`  Local: ${bold(`http://localhost:${port}/`)}`);
  print(dim(remoteUrl
    ? "  Both URLs work on this computer. On other devices, use the remote URL with Tailscale."
    : "  Open the local URL on this computer; Tailscale is not required for local access."));
}
