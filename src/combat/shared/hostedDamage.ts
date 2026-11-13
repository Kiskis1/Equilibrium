/**
 * Pure damage calculations for a host-managed RS3 encounter.
 *
 * Values are the caller's explicit source-backed scenario inputs. This module
 * does not decide ability legality, hit timing, active familiars, HP or targets.
 * Random values are supplied by the host; no RNG state is owned here.
 */
import { applyHitCap } from "../core/hitCaps";
import { floorDamage, percentFloor } from "../core/rounding";

export type HostedRounding = "floor" | "round";

function finiteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("hostedDamage: invalid " + name);
  }
}
function rounded(value: number, mode: HostedRounding): number {
  if (mode === "floor") return floorDamage(value);
  if (mode === "round") return Math.round(value);
  throw new RangeError("hostedDamage: unsupported rounding mode");
}

/** One inclusive integer roll. The encounter supplies exactly one RNG draw. */
export function rollHostedRange(min: number, max: number, draw: number): number {
  if (!Number.isSafeInteger(min) || min < 0 ||
      !Number.isSafeInteger(max) || max < min ||
      !Number.isSafeInteger(max - min + 1) ||
      !Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new RangeError("hostedDamage: invalid inclusive range or RNG draw");
  }
  return min + Math.floor(draw * (max - min + 1));
}

export function rollFamiliarAuto(minDamage: number, maxDamage: number, draw: number): number {
  return rollHostedRange(minDamage, maxDamage, draw);
}

export function rollFamiliarSpecial(
  maximumDamage: number, minimumPercent: number, maximumPercent: number, draw: number,
): number {
  finiteNonnegative(maximumDamage, "familiar maximum damage");
  return percentFloor(maximumDamage, rollHostedRange(minimumPercent, maximumPercent, draw));
}

/** Config-derived Arisen Flesh calculation; rules remain explicitly uncalibrated
 * until matching-game evidence is supplied. No self damage is applied here. */
export interface ArisenDamageInput {
  readonly hp: number;
  readonly maxHp: number;
  readonly selfHpFraction: number;
  readonly selfDamageMultiplier: number;
  readonly lowHpFraction: number;
  readonly bonusFraction: number;
  readonly lowHpMultiplier: number;
  readonly lowHpBasis: "before_cost" | "after_cost";
  readonly bonusBasis: "nominal" | "effective";
}
export function resolveArisenDamage(input: ArisenDamageInput): {
  nominal: number; selfDamage: number; bonus: number; lowHealth: boolean;
} {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "number") finiteNonnegative(value, name);
  }
  if (input.maxHp <= 0 || input.hp > input.maxHp ||
      !["before_cost", "after_cost"].includes(input.lowHpBasis) ||
      !["nominal", "effective"].includes(input.bonusBasis)) {
    throw new RangeError("hostedDamage: invalid Arisen state");
  }
  const nominal = floorDamage(input.maxHp * input.selfHpFraction);
  const selfDamage = floorDamage(nominal * input.selfDamageMultiplier);
  const lowHp = input.lowHpBasis === "before_cost" ? input.hp : Math.max(0, input.hp - selfDamage);
  const lowHealth = lowHp < input.maxHp * input.lowHpFraction;
  const basis = input.bonusBasis === "nominal" ? nominal : Math.min(input.hp, selfDamage);
  const bonus = floorDamage(basis * input.bonusFraction * (lowHealth ? input.lowHpMultiplier : 1));
  return { nominal, selfDamage, bonus, lowHealth };
}

export function resolveConjureBonus(
  hostDamage: number, bonusDamage: number, hitCap: number, sharesCap: boolean,
): number {
  finiteNonnegative(hostDamage, "conjure host damage");
  finiteNonnegative(bonusDamage, "conjure attached damage");
  return sharesCap ? applyHitCap(hostDamage + bonusDamage, { cap: hitCap }) : hostDamage + bonusDamage;
}

export interface HostedHealingBand {
  readonly limit?: number | null;
  readonly percent: number;
}
/** Piecewise nominal Soul Split, before the host's missing-HP healing cap. */
export function resolveSoulSplitNominal(input: {
  readonly damage: number;
  readonly bands: readonly HostedHealingBand[];
  readonly multiplier: number;
  readonly secondaryMultiplier: number;
  readonly targetHp?: number;
  readonly targetHpCapFraction: number;
  readonly rounding: HostedRounding | "none";
}): number {
  finiteNonnegative(input.damage, "Soul Split damage");
  finiteNonnegative(input.multiplier, "Soul Split multiplier");
  finiteNonnegative(input.secondaryMultiplier, "Soul Split secondary multiplier");
  finiteNonnegative(input.targetHpCapFraction, "Soul Split target HP cap");
  if (input.targetHp !== undefined) finiteNonnegative(input.targetHp, "Soul Split target HP");
  if (!Array.isArray(input.bands) || input.bands.length === 0) {
    throw new RangeError("hostedDamage: missing Soul Split bands");
  }
  let amount = 0;
  let previous = 0;
  for (const band of input.bands) {
    const end = band.limit ?? input.damage;
    finiteNonnegative(end, "Soul Split band end");
    finiteNonnegative(band.percent, "Soul Split band percent");
    if (end < previous) throw new RangeError("hostedDamage: unordered Soul Split bands");
    amount += Math.max(0, Math.min(input.damage, end) - previous) * band.percent / 100;
    previous = end;
  }
  amount *= input.multiplier * input.secondaryMultiplier;
  amount = Math.min(amount, input.targetHpCapFraction === 0 ? 0
    : (input.targetHp ?? Infinity) * input.targetHpCapFraction);
  if (input.rounding === "none") return amount;
  return rounded(amount, input.rounding);
}

export function resolveSplitSoulConvertedDamage(
  nominalHealing: number, splitMultiplier: number, targetMultiplier: number,
  mode: HostedRounding,
): number {
  finiteNonnegative(nominalHealing, "Split Soul nominal healing");
  finiteNonnegative(splitMultiplier, "Split Soul multiplier");
  finiteNonnegative(targetMultiplier, "Split Soul target multiplier");
  return rounded(nominalHealing * splitMultiplier * targetMultiplier, mode);
}

export function resolveBloodSiphonFinisher(input: {
  readonly rolled: number;
  readonly uncapped: number;
  readonly restored: number;
  readonly potential: number;
  readonly cap: number;
}): { damage: number; uncappedDamage: number } {
  finiteNonnegative(input.rolled, "Blood Siphon rolled damage");
  finiteNonnegative(input.uncapped, "Blood Siphon uncapped damage");
  finiteNonnegative(input.restored, "Blood Siphon restored healing");
  if (!Number.isFinite(input.potential) || input.potential < 0 || input.potential > 1) {
    throw new RangeError("hostedDamage: invalid Blood Siphon potential");
  }
  const attached = floorDamage(input.restored * input.potential);
  return {
    damage: applyHitCap(input.rolled + attached, { cap: input.cap }),
    uncappedDamage: input.uncapped + attached,
  };
}

/** Damage prevention amount only; host owns Valour, order and incoming HP. */
export function resolvePhantomPrevention(
  incomingDamage: number, baseAbilityDamage: number, enabled: boolean,
): number {
  finiteNonnegative(incomingDamage, "Phantom incoming damage");
  finiteNonnegative(baseAbilityDamage, "Phantom base ability damage");
  return enabled ? floorDamage(Math.min(incomingDamage * 0.05, baseAbilityDamage * 0.1)) : 0;
}