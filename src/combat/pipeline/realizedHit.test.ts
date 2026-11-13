import { describe, expect, it } from "vitest";
import { calculateRawHitBand, sampleRealizedHit } from "./calculateHit";

const hit = {
  base: 1000,
  band: { minPct: 100, maxPct: 200 },
  level: 90,
  accuracy: 1,
  crit: { chance: 0.25 },
} as const;

function draws(...samples: number[]) {
  let pos = 0;
  const random = () => {
    if (pos >= samples.length) throw new Error("extra RNG draw");
    return samples[pos++];
  };
  return { random, used: () => pos };
}

describe("sampleRealizedHit", () => {
  it("uses exactly a crit draw followed by one inclusive band draw", () => {
    const rng = draws(0.8, 0);
    const result = sampleRealizedHit({ ...hit, random: rng.random });
    expect(result).toMatchObject({
      crit: false,
      rawRoll: 1000,
      damage: calculateRawHitBand({
        min: 1000, max: 1000, level: 90, accuracy: 1,
        crit: { chance: 0 },
      }).expected,
    });
    expect(rng.used()).toBe(2);
  });

  it("shares the same integer critical modifier, DP and cap pipeline", () => {
    const rng = draws(0, 0.999);
    const result = sampleRealizedHit({
      ...hit, accuracy: 0.67, cap: { cap: 1200 },
      random: rng.random,
    });
    const oracle = calculateRawHitBand({
      min: result.rawRoll, max: result.rawRoll,
      level: 90, accuracy: 0.67, cap: { cap: 1200 },
      crit: { chance: 1, guaranteed: true },
    });
    expect(result.crit).toBe(true);
    expect(result.damage).toBe(oracle.expected);
    expect(result.uncappedDamage).toBe(oracle.uncappedExpected);
    expect(rng.used()).toBe(2);
  });

  it("does not spend crit RNG for noncritical-eligible attached and DoT hits", () => {
    const rng = draws(0.5);
    const result = sampleRealizedHit({
      ...hit, crit: { chance: 0.5, eligible: false },
      random: rng.random,
    });
    expect(result.crit).toBe(false);
    expect(rng.used()).toBe(1);
  });

  it("still spends the crit RNG when chance is zero but the hit is eligible", () => {
    const rng = draws(0.7, 0.4);
    const result = sampleRealizedHit({
      ...hit, crit: { chance: 0 },
      random: rng.random,
    });
    expect(result.crit).toBe(false);
    expect(rng.used()).toBe(2);
  });

  it("uses original precise and ability-base modifier stage rules", () => {
    const rng = draws(0.7, 0);
    const result = sampleRealizedHit({
      ...hit, preciseRank: 6, crit: { chance: 0 },
      random: rng.random,
    });
    const baseline = calculateRawHitBand({
      min: result.rawRoll, max: result.rawRoll,
      level: 90, accuracy: 1, crit: { chance: 0 },
    });
    expect(result.damage).toBe(baseline.expected);
    expect(result.rawRoll).toBeGreaterThan(1000);
    expect(rng.used()).toBe(2);
  });

  it("rejects invalid draws and unsupported damage-only crit layers", () => {
    expect(() => sampleRealizedHit({ ...hit, random: () => 1 })).toThrow(/RNG/);
    expect(() => sampleRealizedHit({ ...hit, random: () => -0.1 })).toThrow(/RNG/);
    expect(() => sampleRealizedHit({
      ...hit, random: () => 0.5,
      critDamageDistribution: { minBonus: 0, maxBonus: 0.2, points: 3 },
    })).toThrow(/explicit roll contract/);
  });
});
