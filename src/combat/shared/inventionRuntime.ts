/**
 * Shared, host-neutral Invention state transitions. This is the only place
 * deciding when Crackling / Aftershock fire; hosts own targets and damage application.
 * Event descriptors and state contain JSON data only, never closures.
 *
 * Equilibrium's statistical simulator supplies a distribution summary, while a
 * concrete fight MUST supply a settled integer. These types are intentionally
 * discriminated so expected damage cannot be silently spent as target HP.
 */
import { capabilitiesOf, type DamageProvenance } from "./damageProvenance";
import {
  AFTERSHOCK_DAMAGE_STEP_PER_RANK,
  AFTERSHOCK_DAMAGE_THRESHOLD,
  AFTERSHOCK_FORMULA_MAX_RANK,
  AFTERSHOCK_MAX_AD_FRACTION_PER_RANK,
  AFTERSHOCK_MIN_AD_FRACTION_PER_RANK,
  AFTERSHOCK_MIN_PROC_INTERVAL_SECONDS,
  CRACKLING_COOLDOWN_SECONDS,
  CRACKLING_FORMULA_MAX_RANK,
  cracklingDamageFraction,
} from "./perks";

export interface InventionChargeState {
  cracklingReadyTick: number;
  aftershockCharge: number;
  aftershockReadyTick: number;
  aftershockPending: boolean;
}

export type InventionDamage =
  | { readonly kind: "realized"; readonly integer: number }
  | { readonly kind: "summary"; readonly min: number; readonly max: number; readonly expected: number };

export interface InventionLandedHit {
  readonly tick: number;
  readonly targetId: string;
  readonly abilityId: string;
  readonly family: string;
  readonly provenance: DamageProvenance;
  /** A post-mitigation, credited host hit. Do not count attached proc riders twice. */
  readonly damage: InventionDamage;
}

export interface InventionRanks {
  readonly aftershockRank?: number;
  readonly cracklingRank?: number;
}

export interface InventionProcDescriptor {
  readonly kind: "aftershock" | "crackling";
  readonly tick: number;
  readonly targetId: string;
  readonly rank: number;
  readonly sourceAbilityId: string;
}

export interface InventionTransition {
  readonly state: InventionChargeState;
  readonly procs: readonly InventionProcDescriptor[];
}

const TICKS_PER_SECOND = 5 / 3;
export const AFTERSHOCK_DAMAGE_STEPS = Math.round(
  (AFTERSHOCK_MAX_AD_FRACTION_PER_RANK - AFTERSHOCK_MIN_AD_FRACTION_PER_RANK) /
    AFTERSHOCK_DAMAGE_STEP_PER_RANK,
);

function rankOrZero(rank: number | undefined, max: number): number {
  return typeof rank === "number" && Number.isInteger(rank) && rank >= 1 && rank <= max
    ? rank
    : 0;
}

function damageForCharge(damage: InventionDamage): number {
  if (damage.kind === "realized") {
    if (!Number.isSafeInteger(damage.integer) || damage.integer < 0) {
      throw new RangeError("Invention realized damage must be a non-negative safe integer");
    }
    return damage.integer;
  }
  if (
    !Number.isFinite(damage.min) || !Number.isFinite(damage.max) ||
    !Number.isFinite(damage.expected) || damage.min < 0 ||
    damage.min > damage.expected || damage.expected > damage.max
  ) {
    throw new RangeError("Invention summary must have min <= expected <= max");
  }
  return damage.expected;
}

/** Conjures add Aftershock charge, but do not gain other on-hit proc capability. */
export function contributesAftershockCharge(provenance: DamageProvenance, abilityId: string): boolean {
  if (abilityId === "aftershock") return false;
  if (provenance.kind === "conjure_auto" || provenance.kind === "conjure_poison") return true;
  return capabilitiesOf(provenance).canTriggerProcs;
}

/**
 * Pure transition: no RNG, no target lookup and no mutation. The scheduled
 * descriptor keeps the target that crossed the threshold, including through
 * a cooldown or a JSON checkpoint.
 */
export function advanceInventionAfterLandedHit(args: {
  readonly state: InventionChargeState;
  readonly hit: InventionLandedHit;
  readonly ranks: InventionRanks;
}): InventionTransition {
  const { state, hit, ranks } = args;
  if (!Number.isSafeInteger(hit.tick) || hit.tick < 0 || !hit.targetId) {
    throw new RangeError("Invention hit requires a non-negative integer tick and target ID");
  }
  const damage = damageForCharge(hit.damage);
  const cracklingRank = rankOrZero(ranks.cracklingRank, CRACKLING_FORMULA_MAX_RANK);
  const aftershockRank = rankOrZero(ranks.aftershockRank, AFTERSHOCK_FORMULA_MAX_RANK);
  const procs: InventionProcDescriptor[] = [];
  let next = state;

  const cracklingEligible = (hit.family === "hit" || hit.family === "dot" || hit.family === "command") &&
    capabilitiesOf(hit.provenance).canTriggerProcs;
  if (cracklingRank > 0 && cracklingEligible && damage > 0 && hit.tick >= next.cracklingReadyTick) {
    next = { ...next, cracklingReadyTick: hit.tick + Math.round(CRACKLING_COOLDOWN_SECONDS * TICKS_PER_SECOND) };
    procs.push({
      kind: "crackling", tick: hit.tick, targetId: hit.targetId,
      rank: cracklingRank, sourceAbilityId: hit.abilityId,
    });
  }

  if (aftershockRank === 0 || damage <= 0) return { state: next, procs };
  if (hit.abilityId === "aftershock") {
    return {
      state: {
        ...next,
        aftershockCharge: 0,
        aftershockPending: false,
        aftershockReadyTick: hit.tick + Math.round(AFTERSHOCK_MIN_PROC_INTERVAL_SECONDS * TICKS_PER_SECOND),
      },
      procs,
    };
  }
  if (next.aftershockPending || !contributesAftershockCharge(hit.provenance, hit.abilityId)) {
    return { state: next, procs };
  }
  const charge = next.aftershockCharge + damage;
  if (!Number.isFinite(charge) || charge < 0) throw new RangeError("Invention charge overflow");
  if (charge < AFTERSHOCK_DAMAGE_THRESHOLD) {
    return { state: { ...next, aftershockCharge: charge }, procs };
  }
  procs.push({
    kind: "aftershock",
    tick: Math.max(hit.tick, next.aftershockReadyTick),
    targetId: hit.targetId, rank: aftershockRank,
    sourceAbilityId: hit.abilityId,
  });
  return {
    state: { ...next, aftershockCharge: charge, aftershockPending: true },
    procs,
  };
}

/** The authoritative discrete raw-damage endpoints for both simulation modes. */
export function inventionRawDamageAtStep(
  kind: InventionProcDescriptor["kind"],
  rank: number,
  abilityDamage: number,
  step = 0,
): number {
  const max = kind === "aftershock" ? AFTERSHOCK_FORMULA_MAX_RANK : CRACKLING_FORMULA_MAX_RANK;
  if (rankOrZero(rank, max) !== rank || !Number.isFinite(abilityDamage) || abilityDamage < 0) {
    throw new RangeError("Invalid Invention rank or ability damage");
  }
  if (kind === "crackling") {
    if (step !== 0) throw new RangeError("Crackling has no stochastic damage step");
    return Math.floor(abilityDamage * cracklingDamageFraction(rank));
  }
  if (!Number.isInteger(step) || step < 0 || step > AFTERSHOCK_DAMAGE_STEPS) {
    throw new RangeError("Invalid Aftershock damage step");
  }
  const minimumUnits = Math.round(AFTERSHOCK_MIN_AD_FRACTION_PER_RANK * 1000);
  const stepUnits = Math.round(AFTERSHOCK_DAMAGE_STEP_PER_RANK * 1000);
  return Math.floor((abilityDamage * (minimumUnits + step * stepUnits) * rank) / 1000);
}

/**
 * Only called at a concrete proc impact (never from a mask or legality preview).
 * Crackling is deterministic; Aftershock consumes exactly one supplied RNG draw.
 */
export function rollInventionRawDamage(args: {
  readonly kind: InventionProcDescriptor["kind"];
  readonly rank: number;
  readonly abilityDamage: number;
  readonly random: () => number;
}): number {
  if (args.kind === "crackling") {
    return inventionRawDamageAtStep(args.kind, args.rank, args.abilityDamage);
  }
  const uniform = args.random();
  if (!Number.isFinite(uniform) || uniform < 0 || uniform >= 1) {
    throw new RangeError("Invention RNG must return a value in [0, 1)");
  }
  const step = Math.floor(uniform * (AFTERSHOCK_DAMAGE_STEPS + 1));
  return inventionRawDamageAtStep("aftershock", args.rank, args.abilityDamage, step);
}
