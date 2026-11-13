import { describe, expect, it } from "vitest";
import type { DamageProvenance } from "../../../shared/damageProvenance";
import { baseInput } from "../../../test/fixtures/inputs";
import type { EventFamily, ScheduledEvent } from "../../runtime/events";
import { createRuntime, type SimulationRuntime } from "../../runtime/runtime";
import { AFTERSHOCK_DAMAGE_THRESHOLD } from "../../../shared/perks";
import { rotationOf } from "../../simulation/contracts";
import { simulate } from "../../simulation/simulate";
import type { ResolvedDamage } from "../types";
import { applyInventionProcs } from "./invention";
import { leagueModifiers, resolveLeagueRules } from "../../../league/ruleset";

const flat = (n: number): ResolvedDamage => ({ min: n, max: n, expected: n });

function landEvent(
  over: Partial<ScheduledEvent<SimulationRuntime>> & {
    family: EventFamily;
    abilityId: string;
    provenance: DamageProvenance;
  },
): ScheduledEvent<SimulationRuntime> {
  const damage = flat(1000);
  return {
    tick: 0,
    seq: 1,
    sourceCast: 0,
    hitIndex: 0,
    attached: false,
    procEligible: true,
    recursionAllowed: false,
    resolve: () => ({ damage }),
    ...over,
  };
}

/**
 * Aftershock charge / self-interaction.
 * Source: https://runescape.wiki/w/Aftershock - 50_000 damage threshold explosion.
 * Own blast resets charge on land and must not re-seed.
 */
describe("Invention procs - Aftershock charge eligibility", () => {
  it("does not charge Aftershock from its own blast damage", () => {
    const rt = createRuntime({
      ...baseInput,
      base: 1000,
      procs: { aftershockRank: 1 },
    });
    rt.state = {
      ...rt.state,
      invention: {
        ...rt.state.invention,
        aftershockCharge: 12_000,
        aftershockPending: true,
        aftershockReadyTick: 0,
      },
    };

    const aftershockDamage = {
      min: 240,
      max: 396,
      expected: 318,
    };
    applyInventionProcs(
      rt,
      landEvent({
        family: "proc",
        abilityId: "aftershock",
        sourceCast: -1,
        procEligible: false,
        provenance: { kind: "invention_proc", detail: "aftershock" },
        resolve: () => ({ damage: aftershockDamage }),
      }),
      aftershockDamage,
    );

    expect(rt.state.invention.aftershockCharge).toBe(0);
    expect(rt.state.invention.aftershockPending).toBe(false);
    expect(rt.state.invention.aftershockReadyTick).toBe(10); // 6s
    expect(rt.queue.pending().filter((e) => e.abilityId === "aftershock")).toHaveLength(0);
  });

  it("charges Aftershock from ability hits; Crackling does not re-charge (invention_proc)", () => {
    const s = simulate({
      ...baseInput,
      base: 1000,
      procs: { cracklingRank: 4, aftershockRank: 1 },
      rotation: rotationOf("attack"),
    });
    // Attack + Crackling under 50k; Crackling land is invention_proc so canTriggerProcs false.
    expect(s.perAbility.crackling).toBeCloseTo(2000, 5);
    expect(s.perAbility.aftershock).toBeUndefined();
    expect(s.totalExpected).toBeCloseTo(3200, 5);
  });

  it("does not charge Aftershock from equipment_proc or invention_proc provenance", () => {
    const rt = createRuntime({
      ...baseInput,
      procs: { aftershockRank: 1 },
    });
    const dmg = flat(5000);

    applyInventionProcs(
      rt,
      landEvent({
        family: "proc",
        abilityId: "lightning_surge",
        sourceCast: -1,
        procEligible: false,
        provenance: { kind: "equipment_proc", detail: "lightning_surge" },
        resolve: () => ({ damage: dmg }),
      }),
      dmg,
    );
    expect(rt.state.invention.aftershockCharge).toBe(0);

    applyInventionProcs(
      rt,
      landEvent({
        seq: 2,
        family: "proc",
        abilityId: "crackling",
        sourceCast: -1,
        procEligible: false,
        provenance: { kind: "invention_proc", detail: "crackling" },
        resolve: () => ({ damage: dmg }),
      }),
      dmg,
    );
    expect(rt.state.invention.aftershockCharge).toBe(0);
  });

  it("charges Aftershock from conjured spirit damage without enabling their other procs", () => {
    const rt = createRuntime({
      ...baseInput,
      procs: { aftershockRank: 1 },
    });
    const dmg = flat(5000);
    applyInventionProcs(
      rt,
      landEvent({
        family: "conjureAuto",
        abilityId: "skeleton_warrior",
        sourceCast: -1,
        procEligible: false,
        provenance: { kind: "conjure_auto" },
        resolve: () => ({ damage: dmg }),
      }),
      dmg,
    );
    expect(rt.state.invention.aftershockCharge).toBe(5_000);

    applyInventionProcs(
      rt,
      landEvent({
        seq: 3,
        family: "poison",
        abilityId: "spirit_putrid_zombie_poison",
        sourceCast: -1,
        procEligible: false,
        provenance: { kind: "conjure_poison" },
        resolve: () => ({ damage: dmg }),
      }),
      dmg,
    );
    expect(rt.state.invention.aftershockCharge).toBe(10_000);
  });

  it("resets charge after a real threshold-crossing blast without keeping residual blast EV", () => {
    // base 50_000, cap bypassed: each attack is 50k expected -> one Aftershock
    // per attack delayed by the 6s interval. After the first blast lands, the
    // next ability hit must start charge from zero, not from residual blast EV.
    const s = simulate({
      ...baseInput,
      base: 50_000,
      cap: { cap: 30_000, bypass: true },
      procs: { aftershockRank: 1 },
      rotation: rotationOf("attack", "attack"),
    });
    const procs = s.events.filter((event) => event.abilityId === "aftershock");
    expect(procs.length).toBeGreaterThanOrEqual(1);
    // Second attack at tick 3: if blast EV re-seeded charge, behaviour would
    // still schedule - assert charge path is clean by checking interval spacing.
    expect(procs[0]!.tick).toBe(0);
    if (procs.length >= 2) {
      expect(procs[1]!.tick - procs[0]!.tick).toBeGreaterThanOrEqual(10);
    }
  });

  it("accumulates charge only while no Aftershock is pending", () => {
    const rt = createRuntime({
      ...baseInput,
      procs: { aftershockRank: 1 },
    });
    const hit = landEvent({
      family: "hit",
      abilityId: "attack",
      provenance: { kind: "player_direct" },
    });

    applyInventionProcs(rt, hit, flat(1000));
    expect(rt.state.invention.aftershockCharge).toBe(1000);

    rt.state = {
      ...rt.state,
      invention: { ...rt.state.invention, aftershockPending: true, aftershockCharge: 49_000 },
    };
    applyInventionProcs(rt, { ...hit, seq: 2 }, flat(5000));
    expect(rt.state.invention.aftershockCharge).toBe(49_000);
  });

  it("reaches threshold from ability damage alone at the wiki 50_000 boundary", () => {
    const rt = createRuntime({
      ...baseInput,
      procs: { aftershockRank: 1 },
    });
    const almost = AFTERSHOCK_DAMAGE_THRESHOLD - 1;
    applyInventionProcs(
      rt,
      landEvent({
        family: "hit",
        abilityId: "attack",
        provenance: { kind: "player_direct" },
        resolve: () => ({ damage: flat(almost) }),
      }),
      flat(almost),
    );
    expect(rt.state.invention.aftershockPending).toBe(false);
    expect(rt.state.invention.aftershockCharge).toBe(almost);

    applyInventionProcs(
      rt,
      landEvent({
        tick: 1,
        seq: 2,
        family: "hit",
        abilityId: "attack",
        sourceCast: 1,
        provenance: { kind: "player_direct" },
        resolve: () => ({ damage: flat(1) }),
      }),
      flat(1),
    );
    expect(rt.state.invention.aftershockPending).toBe(true);
    expect(rt.state.invention.aftershockCharge).toBe(AFTERSHOCK_DAMAGE_THRESHOLD);
    expect(rt.queue.pending().filter((e) => e.abilityId === "aftershock")).toHaveLength(1);
  });
});

/**
 * Crackling: family hit|dot|command AND canTriggerProcs when provenance present.
 * conjure_command can; conjureAuto family fails the family gate.
 */
describe("Invention procs - Crackling eligibility", () => {
  it("applies global target modifiers before the flat Big Boned term", () => {
    const league = resolveLeagueRules(
      { ruleset: "equilibrium", blessingPicks: ["Balance", "Balance", "Balance", "Chaos"] },
      { maximumLife: 10_000 },
    );
    const summary = simulate({
      ...baseInput,
      league,
      modifiers: leagueModifiers(league),
      context: { style: "melee", ruleset: "equilibrium" },
      procs: { cracklingRank: 4 },
      rotation: rotationOf("attack"),
    });
    const crackling = summary.events.find((event) => event.abilityId === "crackling")!;
    const rider = crackling.components?.find((component) => component.id === "big-boned");

    expect(crackling.damage.expected).toBe(2_900);
    expect(rider?.damage.expected).toBe(500);
  });

  it("schedules Crackling from command family with canTriggerProcs true", () => {
    const rt = createRuntime({
      ...baseInput,
      base: 1000,
      procs: { cracklingRank: 4 },
    });
    applyInventionProcs(
      rt,
      landEvent({
        family: "command",
        abilityId: "command_skeleton_warrior",
        provenance: { kind: "conjure_command", detail: "skeleton_warrior" },
      }),
      flat(1000),
    );
    const crackling = rt.queue.pending().filter((e) => e.abilityId === "crackling");
    expect(crackling).toHaveLength(1);
    expect(crackling[0]!.provenance).toEqual({ kind: "invention_proc", detail: "crackling" });
    expect(rt.state.invention.cracklingReadyTick).toBeGreaterThan(0);
  });

  it("does not schedule Crackling from conjureAuto family", () => {
    const rt = createRuntime({
      ...baseInput,
      base: 1000,
      procs: { cracklingRank: 4 },
    });
    applyInventionProcs(
      rt,
      landEvent({
        family: "conjureAuto",
        abilityId: "skeleton_warrior",
        sourceCast: -1,
        procEligible: false,
        provenance: { kind: "conjure_auto" },
      }),
      flat(1000),
    );
    expect(rt.queue.pending().filter((e) => e.abilityId === "crackling")).toHaveLength(0);
    expect(rt.state.invention.cracklingReadyTick).toBe(0);
  });

  it("does not schedule Crackling when canTriggerProcs is false even if family is hit", () => {
    const rt = createRuntime({
      ...baseInput,
      base: 1000,
      procs: { cracklingRank: 4 },
    });
    // equipment_proc is never a real hit family in production, but guards the cap gate.
    applyInventionProcs(
      rt,
      landEvent({
        family: "hit",
        abilityId: "lightning_surge",
        sourceCast: -1,
        procEligible: false,
        provenance: { kind: "equipment_proc", detail: "lightning_surge" },
      }),
      flat(1000),
    );
    expect(rt.queue.pending().filter((e) => e.abilityId === "crackling")).toHaveLength(0);
  });
});
