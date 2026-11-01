/** Complete queued output before terminating a bounded command's remaining handles. */
export async function exitAfterOutput(code: number): Promise<never> {
  // Finalize the streams: Bun's fast-path write("", callback) can complete while
  // an earlier write is still pending. Do not wait for unrelated process handles.
  // Keep stderr available to the caller's error handler if stdout fails.
  for (const stream of [process.stdout, process.stderr]) {
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  process.exit(code);
}
