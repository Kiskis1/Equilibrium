import { describe, expect, it } from "vitest";
import type { DamageProvenance } from "./damageProvenance";
import {
  AFTERSHOCK_DAMAGE_STEPS,
  advanceInventionAfterLandedHit,
  contributesAftershockCharge,
  inventionRawDamageAtStep,
  rollInventionRawDamage,
  type InventionChargeState,
  type InventionDamage,
  type InventionLandedHit,
} from "./inventionRuntime";

const state = (): InventionChargeState => ({
  cracklingReadyTick: 0,
  aftershockCharge: 0,
  aftershockReadyTick: 0,
  aftershockPending: false,
});
function hit(
  damage: InventionDamage,
  options: Partial<InventionLandedHit> = {},
): InventionLandedHit {
  return {
    tick: 0,
    targetId: "boss",
    abilityId: "necromancy_basic",
    family: "hit",
    provenance: { kind: "player_direct" },
    damage,
    ...options,
  };
}
const realized = (integer: number): InventionDamage => ({ kind: "realized", integer });
const summary = (min: number, expected: number, max: number): InventionDamage => ({
  kind: "summary", min, expected, max,
});
const ranks = { aftershockRank: 4, cracklingRank: 4 };

describe("shared Invention runtime", () => {
  it("only crosses the 50,000 charge threshold when a credited hit lands", () => {
    const s0 = state();
    const a = advanceInventionAfterLandedHit({
      state: s0, hit: hit(realized(49_999)), ranks: { aftershockRank: 4 },
    });
    expect(a.state.aftershockCharge).toBe(49_999);
    expect(a.procs).toEqual([]);
    expect(s0.aftershockCharge).toBe(0); // pure / no hidden mutation
    const b = advanceInventionAfterLandedHit({
      state: a.state, hit: hit(realized(1), { tick: 3, targetId: "arm-left" }),
      ranks: { aftershockRank: 4 },
    });
    expect(b.procs).toEqual([{
      kind: "aftershock", tick: 3, targetId: "arm-left", rank: 4,
      sourceAbilityId: "necromancy_basic",
    }]);
    expect(b.state.aftershockPending).toBe(true);
  });

  it("stores threshold target and delayed proc during cooldown; pending does not charge twice", () => {
    const s = { ...state(), aftershockReadyTick: 20, aftershockCharge: 49_000 };
    const first = advanceInventionAfterLandedHit({
      state: s, hit: hit(realized(1_000), { tick: 11, targetId: "glacyte-2" }),
      ranks: { aftershockRank: 1 },
    });
    expect(first.procs).toHaveLength(1);
    expect(first.procs[0]?.tick).toBe(20);
    expect(first.procs[0]?.targetId).toBe("glacyte-2");
    const second = advanceInventionAfterLandedHit({
      state: first.state, hit: hit(realized(30_000), { tick: 12, targetId: "boss" }),
      ranks: { aftershockRank: 1 },
    });
    expect(second.procs).toEqual([]);
    expect(second.state.aftershockCharge).toBe(50_000);
    const landing = advanceInventionAfterLandedHit({
      state: second.state,
      hit: hit(realized(318), {
        tick: 20, abilityId: "aftershock", family: "proc",
        targetId: "glacyte-2", provenance: { kind: "invention_proc", detail: "aftershock" },
      }),
      ranks: { aftershockRank: 1 },
    });
    expect(landing.state).toMatchObject({
      aftershockCharge: 0, aftershockPending: false, aftershockReadyTick: 30,
    });
    const third = advanceInventionAfterLandedHit({
      state: landing.state, hit: hit(realized(50_000), { tick: 22 }),
      ranks: { aftershockRank: 1 },
    });
    expect(third.procs[0]?.tick).toBe(30);
  });

  it("conjure autos and poison charge Aftershock but never launch Crackling", () => {
    for (const [family, kind] of [
      ["conjureAuto", "conjure_auto"],
      ["poison", "conjure_poison"],
    ] as const) {
      const provenance: DamageProvenance = { kind };
      expect(contributesAftershockCharge(provenance, "spirit")).toBe(true);
      const result = advanceInventionAfterLandedHit({
        state: state(),
        hit: hit(realized(50_000), {
          family, abilityId: "spirit", provenance, targetId: "glacyte",
        }),
        ranks,
      });
      expect(result.procs.map((proc) => proc.kind)).toEqual(["aftershock"]);
      expect(result.procs[0]?.targetId).toBe("glacyte");
    }
  });

  it("equipment and Invention procs cannot recursively charge or trigger Crackling", () => {
    for (const kind of ["equipment_proc", "invention_proc"] as const) {
      const result = advanceInventionAfterLandedHit({
        state: state(),
        hit: hit(realized(60_000), { family: "proc", provenance: { kind } }),
        ranks,
      });
      expect(result.state).toEqual(state());
      expect(result.procs).toEqual([]);
    }
  });

  it("Crackling requires a positive eligible hit and respects its 100-tick cooldown", () => {
    const start = advanceInventionAfterLandedHit({ state: state(), hit: hit(realized(1)), ranks });
    expect(start.procs.map((p) => p.kind)).toEqual(["crackling"]);
    expect(start.state.cracklingReadyTick).toBe(100);
    const before = advanceInventionAfterLandedHit({
      state: start.state, hit: hit(realized(1), { tick: 99 }), ranks,
    });
    expect(before.procs).toEqual([]);
    const ready = advanceInventionAfterLandedHit({
      state: before.state, hit: hit(realized(1), { tick: 100 }), ranks,
    });
    expect(ready.procs.map((p) => p.kind)).toEqual(["crackling"]);
    expect(ready.state.cracklingReadyTick).toBe(200);
  });

  it("keeps summary expected charge different from a realized integer", () => {
    const predicted = advanceInventionAfterLandedHit({
      state: state(), hit: hit(summary(0, 50_000, 100_000)), ranks: { aftershockRank: 1 },
    });
    const actual = advanceInventionAfterLandedHit({
      state: state(), hit: hit(realized(1)), ranks: { aftershockRank: 1 },
    });
    expect(predicted.procs).toHaveLength(1);
    expect(actual.procs).toEqual([]);
    expect(actual.state.aftershockCharge).toBe(1);
    expect(() => advanceInventionAfterLandedHit({
      state: state(), hit: hit(realized(1.5)), ranks,
    })).toThrow("safe integer");
    // A statistical support ledger is not always an ordered min/mean/max band.
    // Only finite values are required. Concrete damage still must be integer.
    expect(advanceInventionAfterLandedHit({
      state: state(), hit: hit(summary(100, 50, 40)), ranks: { aftershockRank: 1 },
    }).state.aftershockCharge).toBe(50);
    expect(() => advanceInventionAfterLandedHit({
      state: state(), hit: hit(summary(100, Number.NaN, 40)), ranks,
    })).toThrow("finite");
  });

  it("uses one externally supplied RNG draw for Aftershock, none for Crackling", () => {
    expect(AFTERSHOCK_DAMAGE_STEPS).toBe(39);
    expect(inventionRawDamageAtStep("aftershock", 4, 1000, 0)).toBe(960);
    expect(inventionRawDamageAtStep("aftershock", 4, 1000, 39)).toBe(1584);
    let n = 0;
    const random = () => { n++; return 0.99999; };
    expect(rollInventionRawDamage({ kind: "crackling", rank: 4, abilityDamage: 1000, random })).toBe(2000);
    expect(n).toBe(0);
    expect(rollInventionRawDamage({ kind: "aftershock", rank: 4, abilityDamage: 1000, random })).toBe(1584);
    expect(n).toBe(1);
    expect(() => rollInventionRawDamage({
      kind: "aftershock", rank: 4, abilityDamage: 1000, random: () => 1,
    })).toThrow("RNG");
  });

  it("state and pending descriptor survive exact JSON recovery with target identity", () => {
    const first = advanceInventionAfterLandedHit({
      state: { ...state(), aftershockReadyTick: 10, aftershockCharge: 49_000 },
      hit: hit(realized(1_000), { tick: 5, targetId: "glacyte-1" }),
      ranks: { aftershockRank: 4 },
    });
    const saved = JSON.parse(JSON.stringify({ state: first.state, queue: first.procs })) as
      { state: InventionChargeState; queue: typeof first.procs };
    expect(saved).toEqual({ state: first.state, queue: first.procs });
    const resolve = (s: InventionChargeState) => advanceInventionAfterLandedHit({
      state: s,
      hit: hit(realized(960), {
        tick: 10, targetId: saved.queue[0]!.targetId,
        family: "proc", abilityId: "aftershock",
        provenance: { kind: "invention_proc", detail: "aftershock" },
      }),
      ranks: { aftershockRank: 4 },
    });
    expect(resolve(saved.state)).toEqual(resolve(first.state));
    expect(saved.queue[0]!.targetId).toBe("glacyte-1");
  });
});
