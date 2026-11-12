import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fixture(
  parent: string,
  version = "1.0.0",
  id = "fixture",
  name = "fixture-extension",
) {
  const source = mkdtempSync(join(parent, "source-"));
  mkdirSync(join(source, "dist"));
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name,
      version,
      wolfpack: {
        manifestVersion: 1,
        apiVersion: 1,
        id,
        ui: "dist/ui.js",
        skills: [],
        documents: [],
      },
    }),
  );
  writeFileSync(join(source, "dist", "ui.js"), "export default () => {};\n");
  return source;
}
