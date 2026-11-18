import { expect, test } from "bun:test";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { getJwtAuthConfig } from "../../src/auth.ts";
import { createServerInstance } from "../../src/server/index.ts";
import { operationalHealth } from "../../src/server/operability.ts";

test("explicit JWT configs isolate HTTP enforcement and operational health", async () => {
  const contexts = [
    createServerContext({ backend: new MockBackend(), config: null,
      jwtAuthConfig: getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "private-fixture-secret-".repeat(3) }) }),
    createServerContext({ backend: new MockBackend(), config: null, jwtAuthConfig: getJwtAuthConfig({}) }),
  ];
  const instances = contexts.map(context => createServerInstance(context));
  try {
    const ports = await Promise.all(instances.map(({ server }) => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("missing fixture port"));
        resolve(address.port);
      });
    })));
    expect((await fetch(`http://127.0.0.1:${ports[0]}/api/sessions`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${ports[1]}/api/sessions`)).status).toBe(200);
    expect(operationalHealth(contexts[0]).auth).toEqual({ mode: "jwt" });
    expect(operationalHealth(contexts[1]).auth).toEqual({ mode: "none" });
  } finally {
    await Promise.all(instances.map(({ server, wss }) => new Promise<void>((resolve, reject) => {
      wss.close();
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    await Promise.all(contexts.map(context => context.close()));
  }
});
