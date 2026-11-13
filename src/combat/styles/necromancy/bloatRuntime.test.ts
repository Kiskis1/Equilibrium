import { describe, expect, it } from "vitest";
import {
  advanceBloatDot,
  newBloatDot,
  resolvedBloatTailDamage,
  shouldOverwriteBloat,
} from "./bloatRuntime";
import {
  BLOAT_DOT_FRACTION,
  BLOAT_DOT_HITS,
  BLOAT_DOT_TICK_INTERVAL,
} from "./abilities";

describe("shared Bloat runtime", () => {
  it("uses exactly the same sourced 25% tail fraction with one integer floor", () => {
    expect(resolvedBloatTailDamage(1000)).toBe(250);
    expect(resolvedBloatTailDamage(1001)).toBe(250);
    expect(resolvedBloatTailDamage(1)).toBe(0);
    expect(resolvedBloatTailDamage(1355)).toBe(338);
    expect(resolvedBloatTailDamage(1000, BLOAT_DOT_FRACTION * 100)).toBe(250);
    expect(() => resolvedBloatTailDamage(-1)).toThrow(RangeError);
  });

  it("schedules ten derived ticks three apart and expires after the tenth", () => {
    const start = newBloatDot({
      id: 12, token: 3, damage: 250, potential: 1, castId: 44, tick: 5,
    });
    expect(start.dot.remaining).toBe(BLOAT_DOT_HITS);
    expect(start.dot.nextTick).toBe(5 + BLOAT_DOT_TICK_INTERVAL);
    expect(start.untilTick).toBe(5 + BLOAT_DOT_HITS * BLOAT_DOT_TICK_INTERVAL + 1);
    let dot = start.dot;
    const visited = [];
    while (dot.remaining > 0) {
      visited.push(dot.nextTick);
      dot = advanceBloatDot(dot, dot.nextTick);
    }
    expect(visited).toEqual(Array.from({ length: 10 }, (_, i) => 8 + i * 3));
    expect(dot.remaining).toBe(0);
    expect(dot.spread).toBe(false);
  });

  it("accepts configured spread counts and delay without changing the cadence", () => {
    const start = newBloatDot({
      id: 7, token: 2, damage: 50, potential: 0.5, tick: 20,
      hits: 3, firstOffset: 0, spread: true,
    });
    expect(start.dot).toMatchObject({
      id: 7, token: 2, damage: 50, potential: 0.5,
      remaining: 3, nextTick: 20, spread: true,
    });
    expect(start.untilTick).toBe(27);
    expect(advanceBloatDot(start.dot, 20).nextTick).toBe(23);
  });

  it("fails rather than replaying stale tick, invalid count or invalid snapshot state", () => {
    const state = newBloatDot({
      id: 1, token: 1, damage: 90, potential: 1, tick: 12,
    }).dot;
    expect(() => advanceBloatDot(state, 16)).toThrow(/out of order/);
    expect(() => newBloatDot({
      id: 1, token: 1, damage: 90, potential: 1, tick: 12, hits: 0,
    })).toThrow(/hits/);
    expect(() => newBloatDot({
      id: 1, token: 1, damage: 90, potential: 1, tick: 12, firstOffset: -1,
    })).toThrow(/firstOffset/);
    expect(() => newBloatDot({
      id: 1, token: 1, damage: NaN, potential: 1, tick: 12,
    })).toThrow(/damage/);
    expect(() => advanceBloatDot({ ...state, remaining: -1 }, 15)).toThrow(/remaining/);
  });

  it("shares replace/preserve/stronger priority, including expiration boundary", () => {
    const base = {
      existingDamage: 300, existingUntilTick: 40, incomingDamage: 250, tick: 39,
    };
    expect(shouldOverwriteBloat({ ...base, policy: "preserve" })).toBe(false);
    expect(shouldOverwriteBloat({ ...base, policy: "stronger" })).toBe(false);
    expect(shouldOverwriteBloat({ ...base, policy: "replace" })).toBe(true);
    expect(shouldOverwriteBloat({
      ...base, incomingDamage: 301, policy: "stronger",
    })).toBe(true);
    expect(shouldOverwriteBloat({
      ...base, tick: 40, policy: "preserve",
    })).toBe(true);
    expect(shouldOverwriteBloat({
      tick: 2, incomingDamage: 20, policy: "preserve",
    })).toBe(true);
    expect(() => shouldOverwriteBloat({
      ...base, policy: "wrong" as "replace",
    })).toThrow(/policy/);
  });
});
