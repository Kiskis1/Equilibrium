import { describe, expect, it } from "vitest";
import { baseInput } from "../../test/fixtures/inputs";
import { NECROMANCY_ABILITIES } from "../../styles/necromancy/abilities";
import { createRuntime } from "./runtime";
import { advanceTo } from "./clock";
import { performCast } from "../cast";
import {
  advanceEofReaper,
  eofReaperBonus,
  isEofEquipped,
  isEofReaperHitEligible,
  newEofReaperState,
  resolveEofSoulSplit,
} from "../../shared/eofPassives";

const necroBasic = NECROMANCY_ABILITIES.find(spec => spec.id === "necromancy_basic")!;

describe("Shared EoF rules in actual Equilibrium engine", () => {
  it("uses physically equipped EOF for Reaper at landed hit, affecting subsequent accuracy", () => {
    const input = {
      ...baseInput, accuracy: 0.5,
      context: { style: "necromancy" as const },
      abilities: NECROMANCY_ABILITIES,
      equipmentIds: ["item:essence-of-finality"],
      equipmentSlots: { amulet: "item:essence-of-finality" },
      startingAdrenaline: 100,
    };
    const rt = createRuntime(input);
    expect(performCast(rt, necroBasic, 0, false)).toEqual({ ok: true });
    advanceTo(rt, 1);
    expect(rt.state.accessories.reaper.stacks).toBe(1);
    expect(eofReaperBonus(rt.state.accessories.reaper, 1)).toBeCloseTo(0.001, 10);
    expect(performCast(rt, necroBasic, 3, false)).toEqual({ ok: true });
    advanceTo(rt, 4);
    expect(rt.state.accessories.reaper.stacks).toBe(2);
    const hitPotential = [...rt.hitDetails.values()].map(h => h.potential);
    expect(hitPotential.some(x => x > 0.5 && x < 0.503)).toBe(true);

    const without = createRuntime({ ...input, equipmentIds: [], equipmentSlots: { amulet: null } });
    expect(performCast(without, necroBasic, 0, false)).toEqual({ ok: true });
    advanceTo(without, 1);
    expect(without.state.accessories.reaper.stacks).toBe(0);
  });

  it("never gives Reaper from conjures/procs, clamps at 30 and resets after 90 ticks", () => {
    expect(isEofEquipped({ equipmentSlots: { amulet: null }, equipmentIds: ["item:essence-of-finality"] })).toBe(false);
    expect(isEofReaperHitEligible({ kind: "conjure_auto" })).toBe(false);
    expect(isEofReaperHitEligible({ kind: "invention_proc" })).toBe(false);
    let state = newEofReaperState();
    for (let tick = 0; tick < 35; tick++) {
      state = advanceEofReaper({state, tick, equipped:true, eligible:true, landed:true});
    }
    expect(state.stacks).toBe(30);
    expect(eofReaperBonus(state, 35)).toBeCloseTo(0.03, 10);
    expect(eofReaperBonus(state, state.expiresTick)).toBe(0);
    state = advanceEofReaper({state, tick:state.expiresTick, equipped:true, eligible:true, landed:true});
    expect(state.stacks).toBe(1);
  });

  it("uses settled integer Soul Split heal / converted damage without consuming RNG", () => {
    expect(resolveEofSoulSplit({nominal:100, equipped:true, activated:true, bonusFraction:0.25})).toBe(125);
    expect(resolveEofSoulSplit({nominal:100, equipped:true, activated:true, bonusFraction:0.50})).toBe(150);
    expect(resolveEofSoulSplit({nominal:100, equipped:true, activated:false})).toBe(100);
    expect(resolveEofSoulSplit({nominal:100, equipped:false, activated:true})).toBe(100);
    expect(() => resolveEofSoulSplit({nominal:9.5, equipped:true, activated:true, bonusFraction:0.3})).toThrow();
  });
});
