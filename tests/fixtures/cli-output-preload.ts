// Replace only the HTTP boundary; execute the production CLI entrypoint/exit path.
const body = JSON.parse(await Bun.stdin.text());
globalThis.fetch = Object.assign(async () => Response.json(body, {
  status: Number(process.env.CLI_OUTPUT_STATUS ?? 200),
}), { preconnect: fetch.preconnect });

// A completed bounded command must still exit when another resource is referenced.
if (process.env.CLI_OUTPUT_KEEP_ALIVE === "1") {
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
}

export {};
