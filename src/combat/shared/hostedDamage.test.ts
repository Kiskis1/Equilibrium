import { describe, expect, it } from "vitest";
import {
  rollHostedRange, rollFamiliarAuto, rollFamiliarSpecial, resolveArisenDamage,
  resolveConjureBonus, resolveSoulSplitNominal, resolveSplitSoulConvertedDamage,
  resolveBloodSiphonFinisher, resolvePhantomPrevention,
  scaleHostedBand, soulCrushHostedBand, deathSparkHostedBand,
  skeletonRageHostedBand, nexusHauntedBonus, bloodSiphonPulseNominal,
  bonesAdjustedArmourRating, hostedDamageMultiplier, hostedReflectReduction,
  hostedMitigationDamage, hostedResonanceHealing, hostedReductionFromTier,
  hostedEquipmentReduction, hostedCombinedReduction, hostedPrayerRetainedMultiplier,
  hostedResonanceFraction,
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

describe("remaining host-supplied pure damage calculations", () => {
  it("scales percentage bands before one subsequent hit roll", () => {
    expect(scaleHostedBand({ minPct: 90, maxPct: 110 }, 1.5)).toEqual({ minPct: 135, maxPct: 165 });
    expect(soulCrushHostedBand({ minPct: 135, maxPct: 165 }, 3)).toEqual({ minPct: 540, maxPct: 660 });
    expect(deathSparkHostedBand({ minPct: 90, maxPct: 110 }, true)).toEqual({ minPct: 180, maxPct: 220 });
    expect(skeletonRageHostedBand({ minPct: 22, maxPct: 28 }, 0)).toEqual({ minPct: 22, maxPct: 28 });
    expect(() => soulCrushHostedBand({ minPct: 90, maxPct: 110 }, 6)).toThrow();
  });
  it("uses source-backed Haunted/Nexus and Blood Siphon nominal calculations", () => {
    expect(nexusHauntedBonus(1000, 1000)).toBe(100);
    expect(nexusHauntedBonus(1000, 1000, 20, 10)).toBe(100);
    expect(bloodSiphonPulseNominal(1234, 25)).toBe(308);
  });
  it("calculates Bones defence rating and layered incoming reductions", () => {
    expect(bonesAdjustedArmourRating({
      baseRating: 1000, stacks: 3, reductionPercentPerStack: 0.2, rounding: "none",
    })).toBe(994);
    expect(hostedDamageMultiplier(100, 0.75)).toBe(75);
    expect(hostedReflectReduction(100, 0.5)).toEqual({ damage: 50, prevented: 50 });
    expect(hostedMitigationDamage({
      damage: 1000, eligible: true, defenceReduction: 0.1, equipmentReduction: 0.2,
      stacking: "multiplicative", roundingStage: "per_layer", rounding: "floor",
      minimumDamage: 1,
    })).toBe(720);
    expect(hostedMitigationDamage({
      damage: 1000, eligible: false, defenceReduction: 0.1, equipmentReduction: 0.2,
      stacking: "multiplicative", roundingStage: "per_layer", rounding: "floor",
      minimumDamage: 1,
    })).toBe(1000);
    expect(hostedResonanceHealing(300, 10, 10, 3, "floor")).toBe(120);
  });
});

describe("shared incoming mitigation composition", () => {
  it("keeps additive and multiplicative composition source-backed", () => {
    expect(hostedReductionFromTier(90, 0.25)).toBe(0.225);
    expect(hostedEquipmentReduction([0.1, 0.2], "sum")).toBeCloseTo(0.3);
    expect(hostedEquipmentReduction([0.1, 0.2], "multiplicative")).toBeCloseTo(0.28);
    expect(hostedCombinedReduction(0.2, 0.3, "additive")).toBe(0.5);
    expect(hostedCombinedReduction(0.2, 0.3, "multiplicative")).toBeCloseTo(0.44);
    expect(hostedPrayerRetainedMultiplier(0.5, 20)).toBe(0.3);
    expect(hostedResonanceFraction(10, 10, 3)).toBe(0.4);
  });
});
