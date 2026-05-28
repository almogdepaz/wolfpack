import { describe, expect, test } from "bun:test";
import { GhosttyPrewarmPool } from "../../public/ghostty-prewarm-pool";

describe("GhosttyPrewarmPool", () => {
  test("prewarms up to capacity and consumes instances FIFO", async () => {
    let created = 0;
    const pool = new GhosttyPrewarmPool({
      maxSize: 2,
      create: async () => `ghostty-${++created}`,
    });

    const first = pool.prewarm();
    const second = pool.prewarm();
    const third = pool.prewarm();
    await Promise.all([first, second]);

    expect(third).toBeNull();
    expect(created).toBe(2);
    expect(pool.take()).toEqual({ instance: "ghostty-1", prewarmed: true });
    expect(pool.take()).toEqual({ instance: "ghostty-2", prewarmed: true });
    expect(pool.take()).toEqual({ instance: null, prewarmed: false });
  });

  test("failed prewarm does not poison later prewarm", async () => {
    let attempts = 0;
    const errors: unknown[] = [];
    const pool = new GhosttyPrewarmPool({
      maxSize: 1,
      create: async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return "ghostty-ok";
      },
      onError: (error) => errors.push(error),
    });

    await pool.prewarm();
    await pool.prewarm();

    expect(errors).toHaveLength(1);
    expect(pool.take()).toEqual({ instance: "ghostty-ok", prewarmed: true });
  });
});
