import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production JWT config captures first use, persists across env changes, and reloads in a fresh process", () => {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-jwt-lifetime-"));
  const authUrl = new URL("../../src/auth.ts", import.meta.url).href;
  const issueUrl = new URL("../../src/jwt-issue.ts", import.meta.url).href;
  const env: NodeJS.ProcessEnv = { ...process.env, WOLFPACK_DIR: root };
  delete env.WOLFPACK_TEST;
  function run(fresh: boolean) {
    const child = Bun.spawnSync([process.execPath, "-e", `
      process.env.WOLFPACK_JWT_SECRET = "import-secret-".repeat(4);
      const auth = await import(${JSON.stringify(authUrl)});
      const { issueJwt } = await import(${JSON.stringify(issueUrl)});
      const assign = (label) => {
        process.env.WOLFPACK_JWT_SECRET = (label + "-secret-").repeat(4);
        process.env.WOLFPACK_JWT_ISSUER = label + "-issuer";
        process.env.WOLFPACK_JWT_AUDIENCE = label + "-audience";
        process.env.WOLFPACK_JWT_CLOCK_TOLERANCE_SEC = label === "first" ? "7" : "11";
      };
      assign(${JSON.stringify(fresh ? "later" : "first")});
      const first = auth.getCachedJwtAuthConfig();
      const firstToken = issueJwt();
      assign("later");
      const laterToken = issueJwt();
      const retained = auth.getCachedJwtAuthConfig();
      const validate = token => auth.validateRequestJwt(
        { authorization: "Bearer " + token }, new URL("http://127.0.0.1/api/sessions"), false
      ).ok;
      console.log(JSON.stringify({
        same: first === retained,
        cached: { issuer: retained.issuer, audience: retained.audience, tolerance: retained.clockToleranceSec },
        directIssuer: auth.getJwtAuthConfig().issuer,
        firstValid: validate(firstToken), laterValid: validate(laterToken),
      }));
    `], { env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString());
  }
  try {
    expect(run(false)).toEqual({
      same: true, cached: { issuer: "first-issuer", audience: "first-audience", tolerance: 7 },
      directIssuer: "later-issuer", firstValid: true, laterValid: false,
    });
    expect(run(true)).toEqual({
      same: true, cached: { issuer: "later-issuer", audience: "later-audience", tolerance: 11 },
      directIssuer: "later-issuer", firstValid: true, laterValid: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
