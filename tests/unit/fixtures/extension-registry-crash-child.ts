import { isAbsolute } from "node:path";
import { ExtensionRuntime } from "../../../src/extensions/runtime.ts";

const root = process.env.WP_CRASH_ROOT;
const source = process.env.WP_CRASH_SOURCE;
if (!root || !source || !isAbsolute(root) || !isAbsolute(source)) {
  throw new Error("crash child requires private absolute root and fixture source paths");
}
const runtime = new ExtensionRuntime({
  root,
  installationId: "11111111-1111-4111-8111-111111111111",
});
switch (process.env.WP_CRASH_OP) {
  case "install-v1":
  case "install-v2":
    await runtime.install({ source, trustBrowserCode: true });
    break;
  case "remove":
    runtime.remove("fixture");
    break;
  case "purge":
    runtime.purge("fixture");
    break;
  default:
    throw new Error("unknown crash operation");
}
