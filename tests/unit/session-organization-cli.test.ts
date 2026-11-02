import { expect, test } from "bun:test";
import { parseSessionCommand } from "../../src/cli/session-control.ts";

test("organization parses read and explicit guarded edits, rejecting ambiguous flags", () => {
  expect(parseSessionCommand(["organization", "live", "--json"])).toMatchObject({ ok: true, action: "organization", session: "live", output: "json" });
  expect(parseSessionCommand(["organization", "live", "--group", "ops", "--add-tag", "urgent", "--remove-tag", "waiting", "--revision", "2"])).toMatchObject({ ok: true, group: "ops", addTags: ["urgent"], removeTags: ["waiting"], revision: 2 });
  for (const flags of [["--group", "ops", "--clear-group"], ["--group"], ["--revision", "-1"], ["--revision", "0"], ["--wat"], ["--clear-group", "--clear-group"]]) expect(parseSessionCommand(["organization", "live", ...flags]).ok).toBe(false);
});

test("organization conflict and unsupported hosts have explicit errors without replay", () => {
  for (const [status, code, expectedCalls] of [[409, "ORGANIZATION_CONFLICT", 3], [404, "ORGANIZATION_UNSUPPORTED", 2], [503, "ORGANIZATION_UNAVAILABLE", 3]] as const) {
    const script = `
      let calls = 0;
      const id = "11111111-1111-4111-8111-111111111111";
      globalThis.fetch = async () => {
        calls++;
        if (calls === 1) return Response.json({ sessionId: id });
        if (calls === 2 && ${status} !== 404) return Response.json({ sessionId: id, organization: { group: null, tags: [], revision: 0 } });
        return Response.json({ code: ${JSON.stringify(status === 404 ? undefined : code)}, error: "failure" }, { status: ${status} });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      const exit = await runSessionCommand(["organization", "live", "--group", "ops", "--json"]);
      if (calls !== ${expectedCalls}) throw new Error("unexpected replay");
      process.exitCode = exit;
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, WOLFPACK_TEST: "1" } });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ error: { code } });
  }
});

test("real CLI resolves once, pins remote UUID, and emits canonical JSON without replay", () => {
  const script = `
    const calls = [];
    const id = "11111111-1111-4111-8111-111111111111";
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init]);
      if (!String(url).startsWith("https://target.example.ts.net/")) throw new Error("wrong host");
      if (calls.length === 1) return Response.json({ sessionId: id, terminal: { alive: true } });
      if (calls.length === 2) {
        if (!String(url).endsWith("organization?sessionId=" + id)) throw new Error("not UUID pinned");
        return Response.json({ sessionId: id, organization: { group: null, tags: ["old"], revision: 3 } });
      }
      if (calls.length !== 3) throw new Error("replay");
      const body = JSON.parse(init.body);
      if (body.sessionId !== id || body.expectedRevision !== 3 || body.tags.join() !== "old,new") throw new Error("wrong CAS");
      return Response.json({ sessionId: id, organization: { group: "ops", tags: body.tags, revision: 4 } });
    };
    const { runSessionCommand } = await import("./src/cli/session-control.ts");
    process.exitCode = await runSessionCommand(["organization", "live", "--group", "ops", "--add-tag", "new", "--json"], { kind: "remote", origin: "https://target.example.ts.net", machine: { machineId: "test" } });
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, WOLFPACK_TEST: "1" } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ organization: { group: "ops", tags: ["old", "new"], revision: 4 } });
});
