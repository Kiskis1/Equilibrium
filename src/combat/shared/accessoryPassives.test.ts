import { describe, expect, it, vi } from "vitest";
import { baseInput } from "../test/fixtures/inputs";
import { NECROMANCY_ABILITIES } from "../styles/necromancy/abilities";
import { createRuntime } from "../engine/runtime/runtime";
import { performCast } from "../engine/cast";
import { needsStochasticLanes } from "../engine/runtime/stochastic";
import {
  isOccultistsRingEquipped,
  occultistEligibleCast,
  resolveOccultistInfliction,
  OCCULTIST_INFLICTION_CHANCE,
} from "./accessoryPassives";

const touch = NECROMANCY_ABILITIES.find(a => a.id === "touch_of_death")!;
const finger = NECROMANCY_ABILITIES.find(a => a.id === "finger_of_death")!;
const grasp = NECROMANCY_ABILITIES.find(a => a.id === "death_grasp")!;
const nonAttack = NECROMANCY_ABILITIES.find(a => a.id === "living_death")!;
const command = NECROMANCY_ABILITIES.find(a => a.id === "command_skeleton_warrior")!;

describe("Occultist Infliction shared cast rule", () => {
  it("is strictly equipped-gated and single-roll-per-eligible-cast", () => {
    expect(isOccultistsRingEquipped({})).toBe(false);
    expect(isOccultistsRingEquipped({ equipmentSlots: { ring: "item:occultists-ring" } })).toBe(true);
    expect(isOccultistsRingEquipped({ equipmentIds: ["item:occultists-ring"] })).toBe(true);
    expect(occultistEligibleCast(touch)).toBe(true);
    expect(occultistEligibleCast(finger)).toBe(true);
    expect(occultistEligibleCast(grasp)).toBe(true);
    expect(occultistEligibleCast(nonAttack)).toBe(false);
    expect(occultistEligibleCast(command)).toBe(false);
    expect(OCCULTIST_INFLICTION_CHANCE).toBe(0.1);
  });

  it("gives exactly two stacks after spending, capped at twelve", () => {
    expect(resolveOccultistInfliction({
      equipped: true, eligible: true, activated: true, necrosisStacks: 5,
    })).toEqual({ necrosisStacks: 7, gained: 2, activated: true });
    expect(resolveOccultistInfliction({
      equipped: true, eligible: true, activated: true, necrosisStacks: 11,
    })).toEqual({ necrosisStacks: 12, gained: 1, activated: true });
    for (const [equipped,eligible,activated] of [
      [false,true,true],[true,false,true],[true,true,false],
    ] as const) {
      expect(resolveOccultistInfliction({
        equipped,eligible,activated,necrosisStacks: 4,
      })).toEqual({ necrosisStacks: 4, gained: 0, activated: false });
    }
  });

  it("Equilibrium engine actually invokes the shared rule after Touch of Death", () => {
    const rt = createRuntime({
      ...baseInput,
      abilities: NECROMANCY_ABILITIES,
      level: 99,
      startingAdrenaline: 100,
      context: { style: "necromancy" },
      equipmentIds: ["item:occultists-ring"],
    });
    const bernoulli = vi.spyOn(rt.stochastic, "bernoulli").mockReturnValue(true);
    expect(performCast(rt, touch, 0, false)).toEqual({ ok: true });
    expect(rt.state.necromancy.resources.necrosisStacks).toBe(6);
    expect(bernoulli).toHaveBeenCalledWith("cast:occultist-infliction", 0.1);
    bernoulli.mockRestore();
  });

  it("explicitly reserves stochastic state only when an equipped ring can proc", () => {
    const input = { ...baseInput, abilities: NECROMANCY_ABILITIES,
      equipmentIds: ["item:occultists-ring"] };
    expect(needsStochasticLanes(input, ["touch_of_death"])).toBe(true);
    expect(needsStochasticLanes({ ...input, equipmentIds: [] }, ["touch_of_death"])).toBe(false);
  });
});
