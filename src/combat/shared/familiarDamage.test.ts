import { describe, expect, it } from "vitest";
import type { CombatContext } from "../types";
import { ripperDemonPassiveModifier, ripperDemonPassiveMultiplier } from "./familiarDamage";

const input = (life: number, max = 1000, damageOverTime = false) => ({
  targetLife: life,
  targetMaxLife: max,
  damageOverTime,
});

describe("Ripper Demon shared damage-only passive", () => {
  it("tracks sourced 0–5% target missing LP formula and clamps overfull targets", () => {
    expect(ripperDemonPassiveMultiplier(input(1000))).toBe(1);
    expect(ripperDemonPassiveMultiplier(input(750))).toBe(1.0125);
    expect(ripperDemonPassiveMultiplier(input(500))).toBe(1.025);
    expect(ripperDemonPassiveMultiplier(input(0))).toBe(1.05);
    expect(ripperDemonPassiveMultiplier(input(1200))).toBe(1);
  });

  it("does not amplify DoT; RS3 owns familiar activation and target eligibility", () => {
    expect(ripperDemonPassiveMultiplier(input(100, 1000, true))).toBe(1);
    expect(ripperDemonPassiveModifier(input(100, 1000, true))).toBeNull();
    expect(ripperDemonPassiveModifier(input(1000))).toBeNull();
  });

  it("uses exactly one floor at the ability modifier stage", () => {
    const modifier = ripperDemonPassiveModifier(input(0));
    expect(modifier).not.toBeNull();
    expect(modifier?.id).toBe("familiar:ripper-passive");
    expect(modifier?.stage).toBe("ability");
    expect(modifier?.priority).toBe(25);
    expect(modifier?.apply({ damage: 1001 }, {} as CombatContext).damage).toBe(1051);
    expect(ripperDemonPassiveModifier(input(500))?.apply(
      { damage: 101 }, {} as CombatContext,
    ).damage).toBe(103);
  });

  it("fails closed on invalid LP; source data is not mutated", () => {
    for (const invalid of [-1, NaN, Infinity]) {
      expect(() => ripperDemonPassiveMultiplier(input(invalid))).toThrow(RangeError);
      expect(() => ripperDemonPassiveMultiplier(input(100, invalid))).toThrow(RangeError);
    }
    expect(() => ripperDemonPassiveMultiplier(input(100, 0))).toThrow(RangeError);
    const state = Object.freeze(input(500));
    expect(ripperDemonPassiveMultiplier(state)).toBe(1.025);
    expect(state.targetLife).toBe(500);
  });
});
