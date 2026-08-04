import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import pkg from "../../package.json";

const taskGatewayDocPath = "docs/task-gateway.md";
const taskAdapterContractPath = "docs/task-adapter-contract.md";

describe("task gateway documentation", () => {
  test("publishes one packaged canonical operational guide linked from the readme", () => {
    expect(existsSync(taskGatewayDocPath)).toBe(true);
    expect(pkg.files).toContain(taskGatewayDocPath);

    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain(taskGatewayDocPath);
    expect(readme).not.toContain("default filesystem store");
    expect(readme).not.toContain("same project directory");
  });

  test("ships the harness-neutral adapter contract through every task entry point", () => {
    expect(existsSync(taskAdapterContractPath)).toBe(true);
    expect(pkg.files).toContain(taskAdapterContractPath);
    const adapter = readFileSync(taskAdapterContractPath, "utf-8");
    for (const heading of [
      "## Terminology and responsibility split",
      "## Mandatory and optional conformance profile",
      "## Canonical event-action matrix",
      "## Adapter receive algorithm",
      "## Opaque assignment fields",
      "## Uncertain outcomes and reconciliation",
      "## Gateway and harness readiness",
    ]) expect(adapter).toContain(heading);
    expect(readFileSync("README.md", "utf-8")).toContain(taskAdapterContractPath);
    expect(readFileSync(taskGatewayDocPath, "utf-8")).toContain("task-adapter-contract.md");
    expect(readFileSync("docs/agent-skills.md", "utf-8")).toContain("task-adapter-contract.md");
    expect(readFileSync(taskGatewayDocPath, "utf-8")).toContain("record conforming-adapter structural insertion");
    expect(readFileSync(taskGatewayDocPath, "utf-8")).not.toContain("structurally inserted Pi delivery");
    expect(readFileSync(taskGatewayDocPath, "utf-8")).toContain("### Pi adapter readiness");
    expect(adapter).toContain("only when the canonical destination is the receiver, after receiver structural insertion");
  });

  test("documents the locked gateway lifecycle without copying generated schemas", () => {
    const docs = readFileSync(taskGatewayDocPath, "utf-8");
    const agentSkillDocs = readFileSync("docs/agent-skills.md", "utf-8");
    const routes = [
      "POST /api/tasks/v1/send",
      "GET /api/tasks/v1/status",
      "GET /api/tasks/v1/inbox",
      "POST /api/tasks/v1/message",
      "POST /api/tasks/v1/complete",
      "POST /api/tasks/v1/cancel",
      "POST /api/tasks/v1/delivered",
      "POST /api/tasks/v1/ack",
      "POST /api/tasks/v1/peer/receive",
      "POST /api/tasks/v1/peer/event",
    ];

    for (const route of routes) expect(docs).toContain(route);
    for (const requiredDetail of [
      "docs/generated/control-api.schema.json",
      "~/.wolfpack/tasks",
      "server-owned singleton",
      "trusted local processes and trusted Tailnet machines",
      "canonical HTTPS Tailnet origin",
      "direct fetch federation",
      "provisional receipt",
      "receipt confirmation",
      "sender is authoritative",
      "first accepted terminal event wins",
      "one initial attempt",
      "four total attempts",
      "1, 2, and 4 seconds",
      "10 minutes",
      "10 days",
      "unresolved tasks are retained",
      "paths-only",
      "JWT federation is unsupported",
      "no queue, scheduler, artifact transfer, or transcript transfer",
    ]) expect(docs).toContain(requiredDetail);

    expect(agentSkillDocs).toContain(taskGatewayDocPath);
    expect(agentSkillDocs).not.toContain("default filesystem task store");
    expect(agentSkillDocs).not.toContain("same project directory");
  });
});
