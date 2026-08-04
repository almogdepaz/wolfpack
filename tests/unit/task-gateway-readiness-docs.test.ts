import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("documents a read-only live-peer readiness checklist", () => {
  const docs = readFileSync("docs/task-gateway.md", "utf-8");

  for (const requiredDetail of [
    "## Live-peer readiness checklist",
    "expected Wolfpack version",
    "expected Pi Tasks version",
    "canonical HTTPS Tailnet origin",
    "GET /api/info",
    "machineId",
    "GET /api/tasks/v1/status",
    "without required query parameters",
    "400",
    "application/json",
    "INVALID_REQUEST",
    "404",
    "HTML",
    "401/403",
    "stable broker `sessionId`",
    "pi list",
    "configured/installed pinned Pi Tasks package version/spec",
    "does not prove that the current Pi process loaded the package",
    "pi install npm:@sgtbeatdown/pi-tasks@",
    "separate operator record",
    "fresh Pi start or `/reload`",
    "stops before task creation",
    "fixture-only verification",
  ]) expect(docs).toContain(requiredDetail);

  const readinessSection = docs.slice(docs.indexOf("## Live-peer readiness checklist"), docs.indexOf("## Limits and unsupported scope"));
  expect(readinessSection).not.toContain("POST /api/tasks/v1/send");
  expect(readinessSection).not.toContain("`pi list` output proving the pinned Pi Tasks package is loaded");
  expect(docs).not.toContain("A real second peer is not currently available");
  expect(docs).toContain("Isolated two-server coverage is the deterministic acceptance gate");
  expect(docs).toContain("specific live peer still requires current readiness");
});

test("fails the readiness probe closed on a rejected HTTP status", () => {
  const docs = readFileSync("docs/task-gateway.md", "utf-8");
  const readinessSection = docs.slice(docs.indexOf("## Live-peer readiness checklist"), docs.indexOf("## Limits and unsupported scope"));
  const script = readinessSection.match(/```bash\n([\s\S]+?)\n\s*```/)?.[1];
  expect(script).toBeDefined();

  const runProbe = (status: number) => Bun.spawnSync(["bash", "-c", `
    curl() {
      local headers body
      while [ "$#" -gt 0 ]; do
        case "$1" in
          -D) headers="$2"; shift 2 ;;
          -o) body="$2"; shift 2 ;;
          -w) shift 2 ;;
          -sS) shift ;;
          *) shift ;;
        esac
      done
      printf 'content-type: application/json\\n' > "$headers"
      printf '{"ok":false,"error":{"code":"INVALID_REQUEST"}}\\n' > "$body"
      printf '%s' "$FAKE_STATUS"
    }
    ${script ?? "exit 99"}
  `], {
    env: { ...process.env, FAKE_STATUS: String(status) },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(runProbe(400).exitCode).toBe(0);
  expect(runProbe(404).exitCode).not.toBe(0);
});
