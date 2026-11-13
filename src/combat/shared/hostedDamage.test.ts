import { describe, expect, it } from "vitest";
import {
  rollHostedRange, rollFamiliarAuto, rollFamiliarSpecial, resolveArisenDamage,
  resolveConjureBonus, resolveSoulSplitNominal, resolveSplitSoulConvertedDamage,
  resolveBloodSiphonFinisher, resolvePhantomPrevention,
} from "./hostedDamage";

describe("pure hosted encounter damage", () => {
  it("samples one host-owned roll without consuming an internal RNG", () => {
    expect(rollHostedRange(100, 200, 0)).toBe(100);
    expect(rollFamiliarAuto(100, 200, 0.5)).toBe(150);
    expect(rollFamiliarSpecial(1000, 30, 50, 0.5)).toBe(400);
    expect(() => rollHostedRange(0, 5, 1)).toThrow(RangeError);
  });
  it("keeps the Arisen HP/bonus calculation pure and stage-ordered", () => {
    expect(resolveArisenDamage({
      hp: 600, maxHp: 1000, selfHpFraction: 0.2, selfDamageMultiplier: 1,
      lowHpFraction: 0.5, bonusFraction: 0.4, lowHpMultiplier: 2,
      lowHpBasis: "after_cost", bonusBasis: "nominal",
    })).toEqual({ nominal: 200, selfDamage: 200, lowHealth: true, bonus: 160 });
    expect(resolveConjureBonus(90, 20, 100, true)).toBe(100);
    expect(resolveConjureBonus(90, 20, 100, false)).toBe(110);
  });
  it("calculates Soul Split bands and Split Soul conversion without HP changes", () => {
    const bands = [{ limit: 100, percent: 10 }, { limit: null, percent: 5 }];
    expect(resolveSoulSplitNominal({
      damage: 200, bands, multiplier: 1, secondaryMultiplier: 1,
      targetHp: 500, targetHpCapFraction: 1, rounding: "floor",
    })).toBe(15);
    expect(resolveSplitSoulConvertedDamage(15, 2, 1, "floor")).toBe(30);
  });
  it("handles converted-channel DP and hit cap once", () => {
    expect(resolveBloodSiphonFinisher({
      rolled: 900, uncapped: 1000, restored: 200, potential: 0.5, cap: 950,
    })).toEqual({ damage: 950, uncappedDamage: 1100 });
  });
  it("returns Phantom damage prevention only", () => {
    expect(resolvePhantomPrevention(1000, 400, true)).toBe(40);
    expect(resolvePhantomPrevention(1000, 400, false)).toBe(0);
  });
});