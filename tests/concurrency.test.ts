import { describe, expect, it } from "vitest";
import {
  createLimiter,
  defaultConcurrency,
  mapLimit,
} from "../src/lib/lint/concurrency.js";

describe("defaultConcurrency", () => {
  it("stays within bounds", () => {
    const value = defaultConcurrency();
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(8);
  });
});

describe("mapLimit", () => {
  it("preserves order and passes indexes", async () => {
    const items = [10, 20, 30, 40, 50];
    const result = await mapLimit(items, 2, async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, (5 - index) * 2));
      return item + index;
    });
    expect(result).toEqual([10, 21, 32, 43, 54]);
  });

  it("caps concurrent invocations", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    expect(peak).toBe(3);
  });
});

describe("createLimiter", () => {
  it("exposes active and max", async () => {
    const limiter = createLimiter(2);
    expect(limiter.max).toBe(2);
    expect(limiter.active).toBe(0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = limiter(() => gate);
    expect(limiter.active).toBe(1);
    release();
    await running;
    expect(limiter.active).toBe(0);
  });

  it("runs queued work in order", async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((value) =>
        limiter(async () => {
          order.push(value);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });
});
