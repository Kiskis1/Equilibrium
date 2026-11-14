import { describe, expect, it } from "vitest";
import { NECROMANCY_ABILITIES } from "../../styles/necromancy/abilities";
import { createCastContext } from "./context";
import { createSteppedCastContext } from "./steppedContext";

const basic = NECROMANCY_ABILITIES.find((ability) => ability.id === "necromancy_basic")!;
const sap = NECROMANCY_ABILITIES.find((ability) => ability.id === "soul_sap")!;
const input = {
  base: 1000,
  level: 99,
  accuracy: 1,
  crit: { chance: 0 },
  abilities: [basic, sap],
  startingAdrenaline: 0,
  horizonTicks: 18,
};

describe("opt-in tick-by-tick Equilibrium driver", () => {
  it("keeps one action tick per call and rejects a cast during occupancy", () => {
    const stepped = createSteppedCastContext(input);
    expect(stepped.getState().tick).toBe(0);
    const first = stepped.step("necromancy_basic");
    expect(first).toMatchObject({
      ok: true, processedTick: 0, nextTick: 1, busyUntilTick: 3,
      cast: "necromancy_basic",
    });
    expect(stepped.firstLegalTick("necromancy_basic")).toBe(3);
    expect(stepped.step("necromancy_basic")).toMatchObject({
      ok: false, processedTick: 1, nextTick: 1, busyUntilTick: 3,
    });
    expect(stepped.getState().tick).toBe(1);
    stepped.step();
    stepped.step();
    const second = stepped.step("soul_sap");
    expect(second).toMatchObject({ ok: true, processedTick: 3, nextTick: 4, cast: "soul_sap" });
    expect(stepped.getState().necromancy.resources.residualSouls).toBeGreaterThanOrEqual(0);
  });

  it("matches atomic cast order, resources and land-event accounting", () => {
    const atomic = createCastContext(input);
    expect(atomic.performCast(basic, 0, false)).toEqual({ ok: true });
    expect(atomic.performCast(sap, 3, false)).toEqual({ ok: true });
    const atomicState = atomic.getState();
    expect(atomicState.tick).toBe(6);

    const stepped = createSteppedCastContext(input);
    const events = [];
    events.push(...stepped.step("necromancy_basic").events);
    events.push(...stepped.step().events);
    events.push(...stepped.step().events);
    events.push(...stepped.step("soul_sap").events);
    events.push(...stepped.step().events);
    events.push(...stepped.step().events);
    events.push(...stepped.step().events); // complete second cast at tick 6
    expect(stepped.getState().tick).toBe(7);
    expect(stepped.getState().adrenaline).toBe(atomicState.adrenaline);
    expect(stepped.getState().necromancy.resources).toEqual(
      atomicState.necromancy.resources,
    );

    const a = atomic.finish();
    const b = stepped.finish();
    expect(b.totalExpected).toBeCloseTo(a.totalExpected, 8);
    expect(b.damageByTick).toEqual(a.damageByTick);
    expect(b.casts.map(({ abilityId, tick, adrenalineAfter }) => ({
      abilityId, tick, adrenalineAfter,
    }))).toEqual(a.casts.map(({ abilityId, tick, adrenalineAfter }) => ({
      abilityId, tick, adrenalineAfter,
    })));
    const eventIds = (xs: typeof a.events) =>
      xs.map(({ tick, seq, family, abilityId }) => ({ tick, seq, family, abilityId }));
    expect(eventIds(b.events)).toEqual(eventIds(a.events));
    expect(eventIds(events)).toEqual(eventIds(a.events.filter((x) => x.tick <= 6)));
  });

  it("defers future hits to their proper tick and blocks premature finish", () => {
    const delayed = {
      ...basic,
      id: "delayed_necromancy_basic",
      hits: [{ band: { minPct: 100, maxPct: 100 }, tickOffset: 2 }],
    };
    const stepped = createSteppedCastContext({ ...input, abilities: [delayed] });
    expect(stepped.step(delayed.id).events).toHaveLength(0);
    expect(() => stepped.finish()).toThrow(/unfinished cast occupancy/);
    expect(stepped.step().events).toHaveLength(0);
    const tick2 = stepped.step();
    expect(tick2.events.length).toBeGreaterThan(0);
    expect(tick2.events.every((e) => e.tick === 2)).toBe(true);
    stepped.step();
    expect(stepped.finish().ok).toBe(true);
  });

  it("rejects unknown actions and keeps horizon bounds", () => {
    const stepped = createSteppedCastContext({ ...input, horizonTicks: 1 });
    expect(stepped.step("not_real")).toMatchObject({ ok: false, nextTick: 0 });
    expect(() => stepped.firstLegalTick("not_real")).toThrow(/unknown ability/);
    expect(stepped.step()).toMatchObject({ ok: true, nextTick: 1 });
    expect(stepped.step()).toMatchObject({ ok: false, nextTick: 1 });
  });
});
