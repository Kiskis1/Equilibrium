import type { AbilitySpec } from "../../../pipeline/calculateAbility";
import { calculateHit } from "../../../pipeline/calculateHit";
import {
  applyTimedTargetStatus,
  activeTimedTargetStatus,
  normalizeTimedTargetStatus,
} from "../../../target/timedStatus";
import { capabilitiesOf, type DamageProvenanceKind } from "../../../shared/damageProvenance";
import { deathdealerApplicationChance } from "../../../shared/equipment";
import { keepsAnalysisLedgers } from "../../simulation/contracts";
import { NO_DAMAGE, type EventResolution, type ResolvedDamage } from "../types";
import { scheduleEvent, type SimulationRuntime } from "../../runtime/runtime";
import type { ScheduledEvent } from "../../runtime/events";
import { patchTarget, type TargetVitalityState } from "../../runtime/state";
import {
  DEATH_MARK_DURATION_TICKS, DEATH_MARK_EXECUTION_DAMAGE,
  hostedDeathMarkThreshold, hostedDeathMarkWindow,
} from "../../../shared/hostedDamage";
export {
  DEATH_MARK_DURATION_TICKS, DEATH_MARK_EXECUTION_THRESHOLD,
  DEATH_MARK_EXECUTION_FRACTION, DEATH_MARK_EXECUTION_DAMAGE,
} from "../../../shared/hostedDamage";

export const DEATH_MARK_STATUS_ID = "death-mark";
export const DEATH_MARK_SOURCE_ID = "deathdealer";

type DeathMarkEvent = ScheduledEvent<SimulationRuntime>;

const APPLICATION_KINDS: ReadonlySet<DamageProvenanceKind> = new Set([
  "player_direct",
  "player_auto",
  "derived_bounce",
]);

const EXECUTION_KINDS: ReadonlySet<DamageProvenanceKind> = new Set([
  "player_direct",
  "player_auto",
  "player_dot",
  "derived_bounce",
  "derived_tail",
  "conjure_auto",
  "conjure_command",
  "conjure_poison",
]);

function necromancyAbility(rt: SimulationRuntime, event: DeathMarkEvent): AbilitySpec | undefined {
  const ability = rt.byId.get(event.abilityId);
  return ability?.style === "necromancy" ? ability : undefined;
}

function isEligibleBase(event: DeathMarkEvent): boolean {
  return (
    event.family !== "status" &&
    !event.attached &&
    event.blessingId === undefined &&
    event.provenance.kind !== "target_status"
  );
}

function isNecromancyPlayerEvent(rt: SimulationRuntime, event: DeathMarkEvent): boolean {
  return (
    capabilitiesOf(event.provenance).playerAttack && necromancyAbility(rt, event) !== undefined
  );
}

function isNecromancyConjureEvent(event: DeathMarkEvent): boolean {
  if (
    event.provenance.kind !== "conjure_auto" &&
    event.provenance.kind !== "conjure_command" &&
    event.provenance.kind !== "conjure_poison"
  ) {
    return false;
  }
  const detail = event.provenance.detail ?? "";
  return detail !== "familiar" && !detail.startsWith("familiar:");
}

export function deathMarkApplicationEligible(
  rt: SimulationRuntime,
  event: DeathMarkEvent,
  damageExpected: number,
): boolean {
  return (
    damageExpected > 0 &&
    isEligibleBase(event) &&
    APPLICATION_KINDS.has(event.provenance.kind) &&
    event.convertedChannel !== true &&
    isNecromancyPlayerEvent(rt, event)
  );
}

export function deathMarkExecutionEligible(
  rt: SimulationRuntime,
  event: DeathMarkEvent,
  damageExpected: number,
): boolean {
  if (
    damageExpected <= 0 ||
    !isEligibleBase(event) ||
    !EXECUTION_KINDS.has(event.provenance.kind)
  ) {
    return false;
  }
  return isNecromancyConjureEvent(event) || isNecromancyPlayerEvent(rt, event);
}

function resolveDeathMarkExecution(rt: SimulationRuntime, at: number): EventResolution {
  const provenance = { kind: "target_status" as const, detail: DEATH_MARK_STATUS_ID };
  const hit = calculateHit({
    base: DEATH_MARK_EXECUTION_DAMAGE,
    band: { minPct: 100, maxPct: 100 },
    level: rt.input.level,
    accuracy: rt.input.accuracy,
    crit: { chance: 0, eligible: false },
    provenance,
    context: {
      style: "necromancy",
      damageSource: "proc",
      provenance,
    },
    cap: { cap: DEATH_MARK_EXECUTION_DAMAGE, bypass: true },
  });
  const damage: ResolvedDamage = {
    min: hit.min,
    max: hit.max,
    expected: hit.expected,
    critExpected: hit.critExpected,
    capLoss: 0,
  };
  void at;
  return { damage, hitDetail: hit };
}

function scheduleApplicationLedger(
  rt: SimulationRuntime,
  event: DeathMarkEvent,
  tick: number,
  activated: boolean,
): void {
  if (!keepsAnalysisLedgers(rt.detailLevel)) return;
  scheduleEvent(rt, {
    tick,
    family: "status",
    abilityId: "deathdealer",
    sourceCast: -1,
    hitIndex: 0,
    attached: false,
    procEligible: false,
    recursionAllowed: false,
    originKind: "status",
    provenance: { kind: "target_status", detail: DEATH_MARK_SOURCE_ID },
    statusEffect: "death-mark-application",
    expectedTriggerRolls: 1,
    expectedActivations: activated ? 1 : 0,
    expectedSeparateHits: 0,
    resolve: () => NO_DAMAGE,
  });
  void event;
}

function scheduleExecution(rt: SimulationRuntime, tick: number): void {
  scheduleEvent(rt, {
    tick,
    family: "status",
    abilityId: "death_mark",
    sourceCast: -1,
    hitIndex: 0,
    attached: false,
    procEligible: false,
    recursionAllowed: false,
    originKind: "status",
    provenance: { kind: "target_status", detail: DEATH_MARK_STATUS_ID },
    statusEffect: "death-mark-execution",
    expectedTriggerRolls: 0,
    expectedActivations: 1,
    expectedSeparateHits: 1,
    resolve: resolveDeathMarkExecution,
  });
}

function subtractTargetVitality(
  vitality: TargetVitalityState | undefined,
  expectedDamage: number,
): TargetVitalityState | undefined {
  if (!vitality || !(expectedDamage > 0)) return vitality;
  return {
    ...vitality,
    currentLifePoints: Math.max(0, vitality.currentLifePoints - expectedDamage),
  };
}

export function deathMarkExecutionThreshold(vitality: TargetVitalityState): number {
  return hostedDeathMarkThreshold(vitality.maximumLifePoints);
}

export function deathMarkExecutionWindow(vitality: TargetVitalityState): boolean {
  return hostedDeathMarkWindow(vitality.currentLifePoints, vitality.maximumLifePoints);
}

export function applyDeathMarkLanded(
  rt: SimulationRuntime,
  event: DeathMarkEvent,
  damageExpected: number,
): void {
  if (event.statusEffect === "death-mark-application") return;

  const tick = event.tick;
  const target = rt.state.target;
  const vitality = subtractTargetVitality(target.vitality, damageExpected);
  if (vitality !== target.vitality) rt.state = patchTarget(rt.state, { vitality });
  if (vitality?.currentLifePoints === 0) {
    if (target.deathMark !== undefined) rt.state = patchTarget(rt.state, { deathMark: undefined });
    return;
  }
  if (event.statusEffect === "death-mark-execution") return;

  const normalized = normalizeTimedTargetStatus(target.deathMark, tick);
  if (normalized !== target.deathMark) {
    rt.state = patchTarget(rt.state, { deathMark: normalized });
  }
  const preExisting = activeTimedTargetStatus(normalized, tick);
  if (
    preExisting &&
    deathMarkExecutionEligible(rt, event, damageExpected) &&
    vitality !== undefined &&
    deathMarkExecutionWindow(vitality)
  ) {
    rt.state = patchTarget(rt.state, { deathMark: undefined });
    scheduleExecution(rt, tick);
    return;
  }

  const chance = deathdealerApplicationChance(rt.input.equipmentEffects);
  if (!deathMarkApplicationEligible(rt, event, damageExpected) || chance <= 0) return;
  const activated = rt.stochastic.bernoulli(`deathdealer:application:${event.seq}`, chance);
  scheduleApplicationLedger(rt, event, tick, activated);
  if (activated) {
    rt.state = patchTarget(rt.state, {
      deathMark: applyTimedTargetStatus(
        { id: DEATH_MARK_SOURCE_ID, label: "Deathdealer" },
        tick,
        DEATH_MARK_DURATION_TICKS,
      ),
    });
  }
}
