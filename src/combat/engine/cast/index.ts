import type { AbilityResult, AbilitySpec } from "../../pipeline/calculateAbility";
import { activateRunicCharge } from "../../styles/magic/runicCharge";
import { castRejection, candidateTick, resolveCastAbility, rngPointsFor } from "./rules";
import { scheduleCastEvents } from "./schedule";
import { applyCastEffects, applyCompletionEffects, castEffectContext } from "./effects";
import { prepareCast, type PreparedCast } from "./prepare";
import { advanceTo } from "../runtime/clock";
import { firstLegalTickFor } from "../runtime/state";
import type { CastAttempt, CastRng } from "../simulation/contracts";
import type { CastRecord } from "../simulation/contracts";
import type { SimulationRuntime } from "../runtime/runtime";
import { patchMagic } from "../runtime/state";
import { noteCastsGrowth } from "../../profiling/allocation";
import { resolveIcyTempest } from "../../styles/melee/icyTempest";
import {
  ESSENCE_CORRUPTION_EMPOWERMENT_CHANCE,
  activeEssenceCorruptionStacks,
} from "../../styles/magic/songOfDestruction";
import { isBasicAttack } from "../../shared/adrenalineGain";
import { accountAnalysisCast } from "../analysis";
import { keepsAnalysisLedgers, type DamageSourceKind } from "../simulation/contracts";

function songEmpowermentForCast(
  rt: SimulationRuntime,
  ability: AbilitySpec,
  candidate: number,
  rng: CastRng | undefined,
): boolean {
  const summary = rt.input.equipmentEffects?.songOfDestruction;
  if (summary?.enabled !== true || ability.essenceCorruptionEligible !== true) return false;
  if (
    activeEssenceCorruptionStacks(summary, rt.state.magic.song.essenceCorruption, candidate) < 1
  ) {
    return false;
  }
  const forced = rng?.["essence-corruption-empowerment"];
  return (
    forced ??
    rt.stochastic.bernoulli(
      "cast:essence-corruption-empowerment",
      ESSENCE_CORRUPTION_EMPOWERMENT_CHANCE,
    )
  );
}

function emptyAbilityResult(): AbilityResult {
  return { hits: [], min: 0, max: 0, expected: 0, listedAdrenalineDelta: 0, adrenalineDelta: 0 };
}

export { costOf, spendOf } from "./rules";
export type { PreparedCast } from "./prepare";

export type CastPreparation = { ok: true; prepared: PreparedCast } | { ok: false; error: string };

/**
 * Advance to candidate tick, then validate + prepare. Rejection only advances time;
 * prepareCast is read-only.
 *
 * Mixed Icy Tempest spend groups must be sampled before preparation.
 */
export function prepareSimulationCast(
  rt: SimulationRuntime,
  ability: AbilitySpec,
  readyTick: number,
): CastPreparation {
  const { ability: castAbility } = resolveCastAbility(ability, {
    byId: rt.byId,
    weaponConfiguration: rt.input.weaponConfiguration,
    equipmentIds: rt.input.equipmentIds,
    passiveIds: rt.input.equipmentEffects?.passiveIds,
    league: rt.input.league,
    activeWeapon: rt.input.equipmentEffects?.activeWeapon,
    eofStoredSpecialId: rt.input.eofStoredSpecialId,
  });
  const candidate = Math.max(
    candidateTick(rt.state, readyTick),
    firstLegalTickFor(rt.state, castAbility, rt.input.level),
  );
  advanceTo(rt, candidate);
  const rejection = castRejection(
    rt.state,
    castAbility,
    candidate,
    rt.input.weaponConfiguration,
    rt.input.equipmentIds,
    rt.input.equipmentEffects?.passiveIds,
    rt.byId,
    rt.input.league,
    rt.input.equipmentEffects?.activeWeapon,
    rt.input.eofStoredSpecialId,
  );
  if (rejection) return { ok: false, error: rejection };

  if (castAbility.id === "icy_tempest") {
    const resolved = resolveIcyTempest(
      rt.state.melee.primordialIce,
      candidate,
      rt.state.ringOfVigour,
    );
    if (resolved.outcomes.length > 1) {
      return { ok: false, error: "Icy Tempest mixed stack state requires a sampled outcome" };
    }
  }
  return { ok: true, prepared: prepareCast(rt, castAbility, candidate) };
}

/**
 * One cast split into an immediate start and a deferred completion. The same
 * functions are used by the original cast API and the new tick-driven API:
 * no duplicate cooldown, damage, resource or completion implementation.
 */
export interface StartedCast {
  readonly prepared: PreparedCast;
  readonly rng?: CastRng;
  readonly record: CastRecord;
  readonly completesAt: number;
  readonly completed: boolean;
  readonly tx: SimulationRuntime["lastCastAdrenalineTransaction"];
}

export function startPreparedCast(
  rt: SimulationRuntime,
  prepared: PreparedCast,
  auto: boolean,
  rng?: CastRng,
): StartedCast {
  const record = scheduleCastEvents(rt, prepared, auto);
  applyCastEffects(rt, prepared, rng);
  const tx = rt.lastCastAdrenalineTransaction;
  rt.lastCastAdrenalineTransaction = null;
  const completesAt = prepared.candidate + prepared.occupancyTicks;
  rt.endTick = Math.max(rt.endTick, completesAt);
  return {
    prepared, rng, record, completesAt,
    completed: rt.horizon == null || completesAt < rt.horizon,
    tx,
  };
}

export function finishPreparedCast(rt: SimulationRuntime, started: StartedCast): void {
  if (rt.state.tick < started.completesAt) {
    throw new Error("Cannot complete a cast before its occupancy ends");
  }
  const { prepared, rng, record, tx } = started;
  applyCompletionEffects(castEffectContext(rt, prepared, rng), started.completed);
  record.adrenalineAfter = rt.state.adrenaline;

  if (tx) {
    record.adrenalineTransaction = tx;
    record.adrenalineAfterResources = tx.afterResources;
    record.effectiveCost = tx.effectiveCost;
    record.actualSpend = tx.actualSpend;
    record.refund = tx.spendPreventedBy === "relentless" ? tx.effectiveCost : 0;
    record.adrenalineGained =
      tx.totalAbilityGain +
      tx.otherImmediateGrants +
      tx.conservationOfEnergyRefund +
      tx.ringOfVigourRefund +
      tx.specialRefund;
    const economyDelta =
      tx.totalAbilityGain +
      tx.otherImmediateGrants -
      tx.actualSpend +
      tx.conservationOfEnergyRefund +
      tx.ringOfVigourRefund +
      tx.specialRefund;
    record.result = {
      ...record.result,
      listedAdrenalineDelta: tx.listedGain - tx.listedCost,
      adrenalineDelta: economyDelta,
    };
  }

  noteCastsGrowth();
  if (!rt.casts.includes(record)) rt.casts.push(record);
  if (keepsAnalysisLedgers(rt.detailLevel)) {
    const kind: DamageSourceKind = isBasicAttack(prepared.ability)
      ? "basic-attack"
      : prepared.working.hits.length === 0
        ? "other-modeled"
        : prepared.working.hits.every((hit) => hit.dot === true)
          ? "ability-dot"
          : "ability-direct";
    accountAnalysisCast(rt.analysis, prepared.ability.id, kind);
  }
}

/** Existing rotation simulation remains an atomic full-occupancy cast. */
export function commitCast(
  rt: SimulationRuntime,
  prepared: PreparedCast,
  auto: boolean,
  rng?: CastRng,
): void {
  const started = startPreparedCast(rt, prepared, auto, rng);
  advanceTo(rt, started.completesAt);
  finishPreparedCast(rt, started);
}

export type ReadyCastPreparation =
  | { ok: true; prepared: PreparedCast; rng: CastRng }
  | { ok: false; error: string };

/**
 * Prepare a legal cast at exactly rt.state.tick; NEVER skip cooldowns or GCD.
 * The stepped scheduler is responsible for separately gating occupancy.
 */
export function prepareCastNow(
  rt: SimulationRuntime,
  ability: AbilitySpec,
  rng?: CastRng,
): ReadyCastPreparation {
  const { ability: castAbility } = resolveCastAbility(ability, {
    byId: rt.byId,
    weaponConfiguration: rt.input.weaponConfiguration,
    equipmentIds: rt.input.equipmentIds,
    passiveIds: rt.input.equipmentEffects?.passiveIds,
    league: rt.input.league,
    activeWeapon: rt.input.equipmentEffects?.activeWeapon,
    eofStoredSpecialId: rt.input.eofStoredSpecialId,
  });
  const candidate = rt.state.tick;
  const legalTick = firstLegalTickFor(rt.state, castAbility, rt.input.level);
  if (legalTick > candidate) {
    return { ok: false, error: `${castAbility.id} unavailable until tick ${legalTick}` };
  }
  const rejection = castRejection(
    rt.state,
    castAbility,
    candidate,
    rt.input.weaponConfiguration,
    rt.input.equipmentIds,
    rt.input.equipmentEffects?.passiveIds,
    rt.byId,
    rt.input.league,
    rt.input.equipmentEffects?.activeWeapon,
    rt.input.eofStoredSpecialId,
  );
  if (rejection) return { ok: false, error: rejection };

  const songEmpowered = songEmpowermentForCast(rt, castAbility, candidate, rng);
  const prepared =
    castAbility.id === "icy_tempest"
      ? (() => {
          const resolved = resolveIcyTempest(
            rt.state.melee.primordialIce,
            candidate,
            rt.state.ringOfVigour,
          );
          const index = rt.stochastic.weightedIndex(
            "cast:icy-tempest-outcome",
            resolved.outcomes.map((outcome) => outcome.probability),
          );
          return prepareCast(rt, castAbility, candidate, resolved.outcomes[index]!, songEmpowered);
        })()
      : prepareCast(rt, castAbility, candidate, undefined, songEmpowered);

  const sampledRng: Record<string, boolean> = {};
  for (const point of rngPointsFor(
    rt.state,
    prepared.working,
    prepared.candidate,
    prepared.spend,
    rt.input.adrenaline,
    rt.input.league,
    rt.input.equipmentEffects,
  )) {
    sampledRng[point.id] = rt.stochastic.bernoulli(`cast:${point.id}`, point.chance);
  }
  return { ok: true, prepared, rng: rng ?? (sampledRng as CastRng) };
}

/** Original manual/Revolution cast driver; unchanged occupancy behavior. */
export function performCast(
  rt: SimulationRuntime,
  ability: AbilitySpec,
  readyTick: number,
  auto: boolean,
  rng?: CastRng,
): CastAttempt {
  const { ability: castAbility } = resolveCastAbility(ability, {
    byId: rt.byId,
    weaponConfiguration: rt.input.weaponConfiguration,
    equipmentIds: rt.input.equipmentIds,
    passiveIds: rt.input.equipmentEffects?.passiveIds,
    league: rt.input.league,
    activeWeapon: rt.input.equipmentEffects?.activeWeapon,
    eofStoredSpecialId: rt.input.eofStoredSpecialId,
  });
  const candidate = Math.max(
    candidateTick(rt.state, readyTick),
    firstLegalTickFor(rt.state, castAbility, rt.input.level),
  );
  advanceTo(rt, candidate);
  const attempt = prepareCastNow(rt, castAbility, rng);
  if (!attempt.ok) return attempt;
  commitCast(rt, attempt.prepared, auto, attempt.rng);
  return { ok: true };
}

/** Off-GCD utility casts (Runic Charge): state-machine update and a cast record
 *  without consuming or advancing the global cooldown. */
export function performOffGcdCast(rt: SimulationRuntime, ability: AbilitySpec): void {
  rt.nextCastSeq++;
  if (ability.stateEffect === "runic_charge") {
    rt.state = patchMagic(rt.state, {
      runicCharge: activateRunicCharge(rt.state.magic.runicCharge, rt.state.tick),
    });
  }
  const record: CastRecord = {
    tick: rt.state.tick,
    abilityId: ability.id,
    result: emptyAbilityResult(),
    adrenalineAfter: rt.state.adrenaline,
    adrenalineBefore: rt.state.adrenaline,
    listedCost: ability.adrenaline?.cost ?? 0,
    effectiveCost: ability.adrenaline?.cost ?? 0,
    actualSpend: 0,
    refund: 0,
    adrenalineGained: 0,
  };
  noteCastsGrowth();
  rt.casts.push(record);
  if (keepsAnalysisLedgers(rt.detailLevel)) {
    accountAnalysisCast(rt.analysis, ability.id, "other-modeled");
  }
  rt.endTick = Math.max(rt.endTick, rt.state.tick + 1);
}
