import {
  TAILNET_ORIGIN_IPC_MESSAGE_TYPE,
} from "../tailnet-origin-fixture.ts";
import type { TailnetOriginReadyMessage } from "../tailnet-origin-fixture.ts";

process.env.WOLFPACK_TEST = "1";

const { __setTestBackend } = await import("../../../src/server/backend.ts");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { activePtySessions } = await import("../../../src/server/websocket.ts");
__setTestBackend(new MockBackend({ sessions: ["dispatch-session"] }));

const { createServerInstance } = await import("../../../src/server/index.ts");
const { server } = createServerInstance();

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const request = message as Record<string, unknown>;
  if (request.type !== TAILNET_ORIGIN_IPC_MESSAGE_TYPE.DISPATCH_STATE || typeof request.requestId !== "string" || typeof request.session !== "string") return;
  process.send?.({
    type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.DISPATCH_STATE,
    requestId: request.requestId,
    dispatched: activePtySessions.get(request.session)?.alive === true,
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  const readyMessage: TailnetOriginReadyMessage = {
    type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY,
    port: address.port,
  };
  process.send?.(readyMessage);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
