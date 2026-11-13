import { describe, expect, it } from "vitest";
import { settleRealizedDamage, settleRealizedHealing } from "./realizedLifePoints";

describe("settleRealizedDamage", () => {
  it("commits only the HP actually available and reports overkill", () => {
    expect(settleRealizedDamage({ currentLife: 120, damage: 200 })).toEqual({
      lifeBefore: 120, lifeAfter: 0, appliedDamage: 120, overkill: 80, dead: true,
    });
    expect(settleRealizedDamage({ currentLife: 120, damage: 40 })).toEqual({
      lifeBefore: 120, lifeAfter: 80, appliedDamage: 40, overkill: 0, dead: false,
    });
  });

  it("handles exact lethal, dead, zero damage, and a precise fractional resolved hit", () => {
    expect(settleRealizedDamage({ currentLife: 45, damage: 45 }).dead).toBe(true);
    expect(settleRealizedDamage({ currentLife: 0, damage: 15 }).appliedDamage).toBe(0);
    expect(settleRealizedDamage({ currentLife: 15, damage: 0 }).lifeAfter).toBe(15);
    expect(settleRealizedDamage({ currentLife: 12.5, damage: 2.25 }).lifeAfter).toBe(10.25);
  });

  it("rejects negative and nonfinite HP or damage without mutating inputs", () => {
    for (const invalid of [-1, Infinity, NaN]) {
      expect(() => settleRealizedDamage({ currentLife: invalid, damage: 1 })).toThrow(RangeError);
      expect(() => settleRealizedDamage({ currentLife: 10, damage: invalid })).toThrow(RangeError);
    }
    const input = Object.freeze({ currentLife: 10, damage: 1 });
    settleRealizedDamage(input);
    expect(input.currentLife).toBe(10);
  });
});

describe("settleRealizedHealing", () => {
  it("respects max life and accounts for overheal without adding phantom HP", () => {
    expect(settleRealizedHealing({ currentLife: 990, maxLife: 1000, healing: 35 })).toEqual({
      lifeBefore: 990, lifeAfter: 1000, appliedHealing: 10, excessHealing: 25,
    });
    expect(settleRealizedHealing({ currentLife: 1000, maxLife: 1000, healing: 150 }))
      .toMatchObject({ lifeAfter: 1000, appliedHealing: 0 });
  });

  it("preserves exact resolved healing without a second rounding stage", () => {
    expect(settleRealizedHealing({ currentLife: 6.5, maxLife: 8, healing: 0.25 }).lifeAfter)
      .toBe(6.75);
  });

  it("fails closed for invalid life pools and heals", () => {
    expect(() => settleRealizedHealing({ currentLife: 101, maxLife: 100, healing: 2 }))
      .toThrow(/exceeds maxLife/);
    for (const invalid of [-1, Infinity, NaN]) {
      expect(() => settleRealizedHealing({ currentLife: 20, maxLife: 100, healing: invalid }))
        .toThrow(RangeError);
      expect(() => settleRealizedHealing({ currentLife: invalid, maxLife: 100, healing: 2 }))
        .toThrow(RangeError);
    }
  });
});
