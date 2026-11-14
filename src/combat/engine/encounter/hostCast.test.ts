import { describe, expect, it } from "vitest";
import { planHostedCast } from "./hostCast";

describe("state-free host cast commit planner", () => {
  it("shares 3-tick GCD, 0.6s cooldown conversion and fixed host adrenaline gain", () => {
    const plan = planHostedCast({
      tick: 7,
      adrenaline: 70,
      spec: {
        id: "touch_of_death",
        adrenaline: { gain: 9 },
        cooldownSeconds: 14.4,
      },
    });
    expect(plan.gcdUntil).toBe(10);
    expect(plan.cooldownUntil).toBe(31);
    expect(plan.adrenalineAfter).toBe(79);
    expect(plan.adrenalineTransaction.actualSpend).toBe(0);
    expect(plan.adrenalineTransaction.totalAbilityGain).toBe(9);
  });

  it("applies the 100% cap, spent costs and channel occupation exactly once", () => {
    const expensive = planHostedCast({
      tick: 0,
      adrenaline: 100,
      spec: { id: "death_skulls", adrenaline: { cost: 65 }, cooldownSeconds: 60 },
    });
    expect(expensive.adrenalineAfter).toBe(35);
    expect(expensive.cooldownUntil).toBe(100);
    expect(expensive.gcdUntil).toBe(3);

    const overcap = planHostedCast({
      tick: 12,
      adrenaline: 98,
      spec: { id: "necromancy_basic", adrenaline: { gain: 9 }, channelTicks: 6 },
    });
    expect(overcap.adrenalineAfter).toBe(100);
    expect(overcap.gcdUntil).toBe(18);
    expect(overcap.cooldownUntil).toBe(12);
  });

  it("preserves sourced defensive cooldowns in ticks and Blood Siphon occupation override", () => {
    const defensive = planHostedCast({
      tick: 8, adrenaline: 50,
      spec: { id: "devotion", adrenaline: { cost: 15 } },
      cooldownTicks: 85,
    });
    expect(defensive.gcdUntil).toBe(11);
    expect(defensive.cooldownUntil).toBe(93);
    expect(defensive.adrenalineAfter).toBe(35);

    const siphon = planHostedCast({
      tick: 8, adrenaline: 50,
      spec: { id: "blood_siphon", channelTicks: 8, adrenaline: { gain: 9 } },
      occupancyTicks: 3,
    });
    expect(siphon.gcdUntil).toBe(11);
    expect(siphon.adrenalineAfter).toBe(59);
  });

  it("does not mutate input data and fails closed on malformed host casts", () => {
    const spec = { id: "touch_of_death", adrenaline: { gain: 9 }, cooldownSeconds: 14.4 };
    const snapshot = JSON.stringify(spec);
    planHostedCast({ tick: 0, adrenaline: 0, spec });
    expect(JSON.stringify(spec)).toBe(snapshot);
    expect(() => planHostedCast({ tick: -1, adrenaline: 0, spec })).toThrow();
    expect(() => planHostedCast({ tick: 0, adrenaline: 101, spec })).toThrow();
    expect(() => planHostedCast({ tick: 0, adrenaline: 0, spec, occupancyTicks: 2.5 })).toThrow();
    expect(() => planHostedCast({ tick: 0, adrenaline: 0, spec: {
      id: "bad", adrenaline: { cost: Number.NaN },
    } })).toThrow();
  });
});
