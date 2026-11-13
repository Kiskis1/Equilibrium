import { describe, expect, it } from "vitest";
import { BLOAT_DOT_FRACTION } from "./abilities";
import { resolvedBloatTailDamage } from "./bloatDamage";

describe("Bloat damage-only calculator", () => {
  it("uses the sourced 25% of one realized initial hit, rounded once", () => {
    expect(resolvedBloatTailDamage(1000)).toBe(250);
    expect(resolvedBloatTailDamage(1001)).toBe(250);
    expect(resolvedBloatTailDamage(1355)).toBe(338);
    expect(resolvedBloatTailDamage(1)).toBe(0);
    expect(resolvedBloatTailDamage(1000, BLOAT_DOT_FRACTION * 100)).toBe(250);
  });

  it("respects an explicit encounter-selected fraction but does not schedule events", () => {
    expect(resolvedBloatTailDamage(999, 25)).toBe(249);
    expect(resolvedBloatTailDamage(999, 10)).toBe(99);
    expect(resolvedBloatTailDamage(0, 25)).toBe(0);
  });

  it("rejects invalid initial damage, fraction and numeric overflow", () => {
    for(const invalid of [NaN,Infinity,-1]) {
      expect(() => resolvedBloatTailDamage(invalid)).toThrow(RangeError);
      expect(() => resolvedBloatTailDamage(100,invalid)).toThrow(RangeError);
    }
    expect(() => resolvedBloatTailDamage(Number.MAX_VALUE,100)).toThrow(/overflow/);
  });
});
