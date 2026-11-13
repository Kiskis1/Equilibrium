import { describe, expect, it } from "vitest";
import { baseInput } from "../test/fixtures/inputs";
import { NECROMANCY_ABILITIES } from "../styles/necromancy/abilities";
import { createRuntime } from "../engine/runtime/runtime";
import { advanceTo } from "../engine/runtime/clock";
import { performCast } from "../engine/cast";
import {
  EOF_REAPER_DURATION_TICKS,
  EOF_SOUL_SPLIT_PROC_CHANCE,
  advanceEofReaper,
  eofReaperBonus,
  isEofEquipped,
  isEofReaperHitEligible,
  newEofReaperState,
  resolveEofSoulSplit,
} from "./eofPassives";

describe("Shared Essence of Finality passive rules", () => {
  it("requires actual amulet, not stale listed inventory ID", () => {
    expect(isEofEquipped({})).toBe(false);
    expect(isEofEquipped({ equipmentIds: ["item:essence-of-finality"] })).toBe(true);
    expect(isEofEquipped({ equipmentSlots: { amulet: "item:essence-of-finality" } })).toBe(true);
    expect(isEofEquipped({
      equipmentSlots: { amulet: "item:other" },
      equipmentIds: ["item:essence-of-finality"],
    })).toBe(false);
    expect(isEofEquipped({ equipmentSlots: { amulet: null } })).toBe(false);
  });

  it("Reaper adds +0.1 percentage points per successful personal hit, max 30, lasting 54 seconds", () => {
    expect(EOF_REAPER_DURATION_TICKS).toBe(90);
    const zero = newEofReaperState();
    const one = advanceEofReaper({ state: zero, tick: 5, equipped: true, eligible: true, landed: true });
    expect(one).toEqual({ stacks: 1, expiresTick: 95 });
    expect(eofReaperBonus(one, 6)).toBeCloseTo(0.001, 10);
    const capped = Array.from({ length: 40 }).reduce(
      (s, _, i) => advanceEofReaper({
        state: s, tick: i + 6, equipped: true, eligible: true, landed: true,
      }), one,
    );
    expect(capped.stacks).toBe(30);
    expect(eofReaperBonus(capped, 45)).toBeCloseTo(0.03, 10);
    const reset = advanceEofReaper({
      state: capped, tick: capped.expiresTick, equipped: true, eligible: true, landed: true,
    });
    expect(reset.stacks).toBe(1);
    expect(eofReaperBonus(capped, capped.expiresTick)).toBe(0);
    expect(advanceEofReaper({
      state: capped, tick: 47, equipped: false, eligible: false, landed: false,
    })).toEqual(zero);
  });

  it("no Reaper from conjures, poison or invention procs", () => {
    for (const kind of ["conjure_auto","conjure_poison","invention_proc","equipment_proc","player_poison"] as const) {
      expect(isEofReaperHitEligible({ kind })).toBe(false);
    }
    for (const kind of ["player_direct","player_dot","derived_bounce"] as const) {
      expect(isEofReaperHitEligible({ kind })).toBe(true);
    }
    expect(advanceEofReaper({
      state: newEofReaperState(), tick: 1, equipped: true, eligible: false, landed: true,
    })).toEqual(newEofReaperState());
  });

  it("Soul Split uses resolved integer outcomes, not an EV multiplier", () => {
    expect(EOF_SOUL_SPLIT_PROC_CHANCE).toBe(0.5);
    expect(resolveEofSoulSplit({
      nominal: 100, equipped: true, activated: true, bonusFraction: 0.25,
    })).toBe(125);
    expect(resolveEofSoulSplit({
      nominal: 100, equipped: true, activated: true, bonusFraction: 0.5,
    })).toBe(150);
    expect(resolveEofSoulSplit({
      nominal: 100, equipped: true, activated: false,
    })).toBe(100);
    expect(resolveEofSoulSplit({
      nominal: 100, equipped: false, activated: true,
    })).toBe(100);
    expect(resolveEofSoulSplit({
      nominal: 100, equipped: true, activated: true, bonusFraction: 0.375,
    })).toBe(137);
    expect(() => resolveEofSoulSplit({
      nominal: 17.4, equipped: true, activated: true, bonusFraction: 0.25,
    })).toThrow("integer");
  });

  it("Equilibrium's own resolution records Reaper stacks and uses them in subsequent hit accuracy", () => {
    const necroBasic = NECROMANCY_ABILITIES.find(spec => spec.id === "necromancy_basic")!;
    const input = {
      ...baseInput,
      accuracy: 0.5,
      context: { style: "necromancy" as const },
      abilities: NECROMANCY_ABILITIES,
      equipmentSlots: { amulet: "item:essence-of-finality" },
      equipmentIds: ["item:essence-of-finality"],
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
    const potentials = [...rt.hitDetails.values()].map(hit => hit.potential);
    expect(potentials.some(potential => potential > 0.5 && potential < 0.503)).toBe(true);

    const without = createRuntime({ ...input, equipmentIds: [], equipmentSlots: { amulet: null } });
    expect(performCast(without, necroBasic, 0, false)).toEqual({ ok: true });
    advanceTo(without, 1);
    expect(without.state.accessories.reaper.stacks).toBe(0);
  });
});
