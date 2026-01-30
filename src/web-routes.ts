import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PluginApi {
  registerHttpRoute(params: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void;
}

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");

function serveFile(res: ServerResponse, filename: string, contentType: string): void {
  try {
    const content = readFileSync(join(PUBLIC_DIR, filename), "utf-8");
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

export function registerWebRoutes(api: PluginApi): void {
  api.registerHttpRoute({
    path: "/bridge/",
    handler: (_req, res) => serveFile(res, "index.html", "text/html; charset=utf-8"),
  });

  api.registerHttpRoute({
    path: "/bridge/manifest.json",
    handler: (_req, res) => serveFile(res, "manifest.json", "application/json"),
  });

  api.registerHttpRoute({
    path: "/bridge/sw.js",
    handler: (_req, res) => {
      try {
        const content = readFileSync(join(PUBLIC_DIR, "sw.js"), "utf-8");
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Service-Worker-Allowed": "/bridge/",
        });
        res.end(content);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    },
  });
}
