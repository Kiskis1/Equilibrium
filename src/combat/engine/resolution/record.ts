import type { ScheduledEvent } from "../runtime/events";
import type { SimulationRuntime } from "../runtime/runtime";
import { applyLandedHitEffects } from "./landed";
import type { EventResolution } from "./types";
import { recordEventAccounting } from "./accounting";
import { releaseScoreOnlyHitDetails } from "./hitDetailsRetention";
import { applyInventionProcs } from "./procs/invention";
import { applyBlessingDamage } from "./league/blessingDamage";
import { applyLeagueLandedHitEffects } from "./landed/league";
import { noteAttachedTermsResolved } from "../../profiling/allocation";
import { applyDeathMarkLanded } from "./landed/deathMark";
import { scheduleInstabilityLightningSurge } from "./landed/magic";
import { applyBotlgLanded } from "./botlg";
import {
  advanceEofReaper,
  isEofEquipped,
  isEofReaperHitEligible,
} from "../../shared/eofPassives";

/** Host or component band mean for a concrete Crit / No-crit outcome. */
function branchExpected(
  hitDetail: NonNullable<EventResolution["hitDetail"]>,
  outcome: boolean,
): number {
  if (outcome) return hitDetail.critExpected ?? hitDetail.expected;
  return hitDetail.nonCritExpected ?? hitDetail.expected;
}

/**
 * Pin one damage payload to the matching band mean.
 * hitDetail must be the pure host (or pure component) means - not a total that
 * already folds attached riders. Callers rebuild totals from host + components.
 */
function pinDamage(
  damage: EventResolution["damage"],
  hitDetail: EventResolution["hitDetail"],
  outcome: boolean,
): EventResolution["damage"] {
  const criticalBase = { ...damage.critical!, outcome };
  if (!hitDetail) return { ...damage, critical: criticalBase };
  const hostBranch = branchExpected(hitDetail, outcome);
  const excess = Math.max(0, hitDetail.critExpected - (hitDetail.nonCritExpected ?? 0));
  return {
    ...damage,
    expected: hostBranch,
    critExpected: hitDetail.critExpected,
    critical: {
      ...criticalBase,
      contribution: outcome ? excess : 0,
    },
  };
}

function materializeCriticalOutcome(
  rt: SimulationRuntime,
  event: ScheduledEvent<SimulationRuntime>,
  resolution: EventResolution,
  inheritedOutcome?: boolean,
): EventResolution {
  const existingOutcome = resolution.damage.critical?.outcome;
  const critical = resolution.damage.critical;
  if (!critical || critical.mode === "none") return resolution;
  const changesFutureState =
    rt.input.league?.blessingIds.has("unholy-critual") === true ||
    event.lightningSurge === true ||
    event.tick < rt.state.magic.tsunamiCritAdrenUntilTick;
  if (
    existingOutcome === undefined &&
    inheritedOutcome === undefined &&
    critical.mode === "expected" &&
    rt.stochastic.laneCount === 1 &&
    !changesFutureState
  ) {
    return resolution;
  }
  // Concrete lanes pin crit damage and every inherited rider to one outcome.
  const outcome =
    existingOutcome ??
    inheritedOutcome ??
    (critical.mode === "guaranteed"
      ? true
      : critical.chance <= 0
        ? false
        : critical.chance >= 1
          ? true
          : rt.stochastic.bernoulli(`land:critical:${event.seq}`, critical.chance));

  const components = resolution.components?.map((component) => {
    const componentCritical = component.damage.critical;
    if (!componentCritical || componentCritical.mode === "none") {
      // Shared riders without their own crit package still inherit the host outcome
      // when they carry hitDetail (Big Boned inherits host crit).
      if (!component.hitDetail) return component;
      const pinned = branchExpected(component.hitDetail, outcome);
      return {
        ...component,
        hitDetail: { ...component.hitDetail, critOutcome: outcome, expected: pinned },
        damage: {
          ...component.damage,
          expected: pinned,
          critExpected: component.hitDetail.critExpected ?? component.damage.critExpected,
        },
      };
    }
    const componentOutcome = componentCritical.outcome ?? outcome;
    const componentHitDetail = component.hitDetail
      ? {
          ...component.hitDetail,
          critOutcome: componentOutcome,
          expected: branchExpected(component.hitDetail, componentOutcome),
        }
      : component.hitDetail;
    return {
      ...component,
      hitDetail: componentHitDetail,
      damage: pinDamage(component.damage, component.hitDetail, componentOutcome),
    };
  });

  const hostHitDetail = resolution.hitDetail
    ? {
        ...resolution.hitDetail,
        critOutcome: outcome,
        expected: branchExpected(resolution.hitDetail, outcome),
      }
    : undefined;

  // Rebuild total from pure host band + every attached component (shared and separate).
  // hitDetail must be pure host (castHit / Inferno baseHit). Do not host-slice
  // replace on damage.expected - that leaves attached riders at EV mass.
  let damage = pinDamage(resolution.damage, resolution.hitDetail, outcome);
  if (components && components.length > 0 && resolution.hitDetail) {
    let total = branchExpected(resolution.hitDetail, outcome);
    let critTotal = resolution.hitDetail.critExpected;
    for (const component of components) {
      total += component.damage.expected;
      critTotal += component.damage.critExpected ?? component.damage.expected;
    }
    damage = { ...damage, expected: total, critExpected: critTotal };
  }

  return {
    ...resolution,
    damage,
    ...(hostHitDetail ? { hitDetail: hostHitDetail } : {}),
    ...(components ? { components } : {}),
  };
}

/**
 * Sole ledger-write step for a landed event (resolvers only calculate).
 * Order: (1) hit-detail + ledgers/cast/event log (2) target state (3) blessing
 * damage (4) Invention procs / Crackling / Aftershock (5) style landed-hit
 * transitions last, against pre-hit state so this hit's damage does not see its
 * own side effects.
 * Score-only then drops hitDetails no longer referenced by pending derived/LS.
 */
export function recordResolved(
  rt: SimulationRuntime,
  event: ScheduledEvent<SimulationRuntime>,
  resolution: EventResolution,
): EventResolution {
  const landed = materializeCriticalOutcome(rt, event, resolution);
  const composed =
    event.family === "status"
      ? landed
      : materializeCriticalOutcome(
          rt,
          event,
          applyBlessingDamage(rt, event, landed),
          landed.damage.critical?.outcome,
        );
  noteAttachedTermsResolved(composed.components?.length ?? 0);
  recordEventAccounting(rt, event, composed);
  if (event.castSnap?.songEmpowered === true && !event.attached) {
    rt.analysis.song.immediateHitCount += 1;
  }
  if (!event.attached) {
    const ability = rt.byId.get(event.abilityId);
    if (ability?.style === "magic") {
      rt.analysis.song.essenceFlatBonusDamage +=
        composed.postDamagePotentialFlatContribution ??
        composed.hitDetail?.postDamagePotentialFlatContribution ??
        0;
    }
  }
  applyDeathMarkLanded(rt, event, composed.damage.expected);

  if (event.family === "status") {
    releaseScoreOnlyHitDetails(rt, event);
    return composed;
  }

  applyBotlgLanded(rt, event, landed);

  const { damage } = composed;
  // The Reaper necklace component of EoF advances only on a landed personal
  // hit; conjures, attached riders, poison and procs cannot seed stacks.
  // This is the SAME pure transition consumed by the RS3 host adapter.
  const reaperEquipped = isEofEquipped(rt.input);
  if (reaperEquipped && !event.attached) {
    const previous = rt.state.accessories.reaper;
    const updated = advanceEofReaper({
      state: previous, tick: event.tick, equipped: true,
      eligible: isEofReaperHitEligible(event.provenance),
      landed: damage.expected > 0,
    });
    if (updated !== previous) {
      rt.state = { ...rt.state, accessories: { ...rt.state.accessories, reaper: updated } };
    }
  }
  if (!event.blessingId) applyInventionProcs(rt, event, damage);

  if (!event.attached && (event.family === "dot" || event.tearingThornsEligible === true)) {
    applyLeagueLandedHitEffects(rt, event, damage);
  }

  // Endless Assault damage is not proc-eligible, but it is still the original
  // channel hit for ability-owned landed effects such as Greater Flurry's
  // Berserk extension.
  if (
    !event.attached &&
    ((event.family === "dot" && rt.byId.get(event.abilityId)?.style === "magic") ||
      event.procEligible ||
      event.convertedChannel ||
      event.bleedId != null)
  ) {
    applyLandedHitEffects(rt, event, damage, composed);
  } else if (event.family === "blessing" && event.lightningSurge) {
    // Magic-style blessing crits (Light/Inferno) are not bar AbilitySpecs; LS only.
    scheduleInstabilityLightningSurge(rt, event);
  }

  releaseScoreOnlyHitDetails(rt, event);
  return composed;
}
