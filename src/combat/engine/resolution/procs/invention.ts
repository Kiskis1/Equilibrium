import type { ScheduledEvent } from "../../runtime/events";
import { scheduleEvent, type SimulationRuntime } from "../../runtime/runtime";
import {
  AFTERSHOCK_DAMAGE_STEPS,
  advanceInventionAfterLandedHit,
  inventionRawDamageAtStep,
} from "../../../shared/inventionRuntime";
import { runPipeline } from "../../../pipeline/modifierPipeline";
import type { ResolvedDamage } from "../types";
import type { AttachedDamageComponent, EventResolution } from "../types";
import { resolveLeagueAttachedTerms } from "../../../league/damage";
import { resolveHostDamageInstance } from "../../../core/hostDamage";
import { targetAndPostHitModifiers } from "../modifiers";

/** Crackling and Aftershock bypass Damage Potential and use only sourced target modifiers. */
function applyProcModifiers(
  rt: SimulationRuntime,
  event: ScheduledEvent<SimulationRuntime>,
  damage: number,
): number {
  const ability = rt.byId.get(event.abilityId) ?? rt.byId.values().next().value;
  const modifiers = targetAndPostHitModifiers(rt, event.tick, ability);
  if (modifiers.length === 0) return damage;
  const provenance = {
    kind: "invention_proc" as const,
    detail: event.abilityId,
  };
  return runPipeline({ damage }, modifiers, {
    ...(rt.input.context ?? { style: ability?.style ?? "melee" }),
    damageSource: "proc",
    provenance,
  }).damage;
}

function damageDelta(after: ResolvedDamage, before: ResolvedDamage): ResolvedDamage {
  return {
    min: after.min - before.min,
    max: after.max - before.max,
    expected: after.expected - before.expected,
  };
}

function procResolution(
  rt: SimulationRuntime,
  event: ScheduledEvent<SimulationRuntime>,
  effectId: "crackling" | "aftershock",
  rawHits: readonly number[],
  atTick: number,
): EventResolution {
  const terms = rt.input.league
    ? resolveLeagueAttachedTerms({
        rules: rt.input.league,
        source: { kind: "invention_proc", detail: effectId },
        landTick: atTick,
        abilityBase: rt.input.base,
      })
    : [];
  const modifiedHits = rawHits.map((hit) => applyProcModifiers(rt, event, hit));
  const composed = resolveHostDamageInstance(
    { host: modifiedHits, attached: terms },
    {
      add: (hits, amount) => hits.map((hit) => hit + amount),
      resolve: (hits): ResolvedDamage => {
        return {
          min: hits[0]!,
          max: hits.at(-1)!,
          expected: hits.reduce((total, hit) => total + hit, 0) / hits.length,
        };
      },
      delta: damageDelta,
    },
  );
  const components: AttachedDamageComponent[] = composed.attached.map(({ term, damage }) => ({
    id: term.id,
    damage,
    attached: true,
    hitCapPolicy: "shared",
    analysis: {
      kind: "league-blessing",
      blessingId: term.blessingId,
      bonusTargetId: effectId,
      expectedActivations: 1,
    },
  }));
  return {
    damage: composed.damage,
    ...(components.length > 0 ? { components } : {}),
  };
}

function cracklingDamage(
  rt: SimulationRuntime,
  event: ScheduledEvent<SimulationRuntime>,
  rank: number,
): EventResolution {
  const raw = inventionRawDamageAtStep("crackling", rank, rt.input.base);
  return procResolution(rt, event, "crackling", [raw], event.tick);
}

function aftershockDamage(
  rt: SimulationRuntime,
  event: ScheduledEvent<SimulationRuntime>,
  rank: number,
  atTick: number,
): EventResolution {
  const hits = Array.from(
    { length: AFTERSHOCK_DAMAGE_STEPS + 1 },
    (_, step) => inventionRawDamageAtStep("aftershock", rank, rt.input.base, step),
  );
  return procResolution(rt, event, "aftershock", hits, atTick);
}

/**
 * Equilibrium's runtime uses summary distributions; an actual host sends a
 * settled integer to the SAME shared transition. This wrapper only adapts
 * scheduled closure events to the existing single-target simulation runtime.
 * The pure transition owns the Invention rules for both consumers.
 */
export function applyInventionProcs(
  rt: SimulationRuntime,
  event: ScheduledEvent<SimulationRuntime>,
  damage: ResolvedDamage,
): void {
  const transition = advanceInventionAfterLandedHit({
    state: rt.state.invention,
    hit: {
      tick: event.tick,
      targetId: "target",
      abilityId: event.abilityId,
      family: event.family,
      provenance: event.provenance,
      damage: { kind: "summary", min: damage.min, max: damage.max, expected: damage.expected },
    },
    ranks: {
      cracklingRank: rt.input.procs?.cracklingRank,
      aftershockRank: rt.input.procs?.aftershockRank,
    },
  });
  rt.state = { ...rt.state, invention: transition.state };
  for (const proc of transition.procs) {
    const resolved = proc.kind === "crackling"
      ? cracklingDamage(rt, event, proc.rank)
      : aftershockDamage(rt, event, proc.rank, proc.tick);
    scheduleEvent(rt, {
      tick: proc.tick,
      family: "proc",
      abilityId: proc.kind,
      sourceCast: -1,
      hitIndex: 0,
      attached: false,
      procEligible: false,
      recursionAllowed: false,
      originKind: "proc",
      provenance: { kind: "invention_proc", detail: proc.kind },
      resolve: () => resolved,
    });
  }
}
