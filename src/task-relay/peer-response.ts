/** Host-side bounds apply before materializing a peer body or cloning it to a worker. */
export async function withPeerAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("peer response aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("peer response aborted");
      return operation();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

export async function readPeerResponse(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  if (signal.aborted || response.redirected || Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("peer response unavailable or oversized");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await withPeerAbort(signal, async () => {
      // Fixed storage also bounds metadata for arbitrarily small streamed chunks.
      const bytes = new Uint8Array(maxBytes); let size = 0;
      for (;;) {
        const part = await reader.read();
        if (signal.aborted) throw new Error("peer response aborted");
        if (part.done) break;
        if (part.value.byteLength > maxBytes - size) throw new Error("peer response oversized");
        bytes.set(part.value, size); size += part.value.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    });
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}
