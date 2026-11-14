/**
 * Pure damage calculations for a host-managed RS3 encounter.
 *
 * Values are the caller's explicit source-backed scenario inputs. This module
 * does not decide ability legality, hit timing, active familiars, HP or targets.
 * Random values are supplied by the host; no RNG state is owned here.
 */
import { applyHitCap } from "../core/hitCaps";
import { floorDamage, percentFloor } from "../core/rounding";
import type { DamageBand } from "../core/abilityDamage";
import { DEATH_SPARK_DAMAGE_MULT } from "../styles/necromancy/deathSpark";
import { skeletonRageMult } from "../styles/necromancy/conjures";
import { hauntedBonusDamage, HAUNTED_BONUS_PCT, HAUNTED_CAP_PCT_OF_AD } from "../styles/necromancy/haunted";

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
    // The open-ended band must remain valid when damage is below an earlier
    // finite threshold (it contributes zero instead of inverting the range).
    const end = band.limit ?? Math.max(previous, input.damage);
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

/** Pure source-backed ability band transforms; host still owns souls and cast timing.
 * Multiplication remains on the percentage band BEFORE the one integer hit roll.
 */
export function scaleHostedBand(band: DamageBand, multiplier: number): DamageBand {
  finiteNonnegative(band.minPct, "band minimum");
  finiteNonnegative(band.maxPct, "band maximum");
  finiteNonnegative(multiplier, "band multiplier");
  if (band.minPct > band.maxPct) throw new RangeError("hostedDamage: inverted damage band");
  const minPct = band.minPct * multiplier;
  const maxPct = band.maxPct * multiplier;
  if (!Number.isFinite(minPct) || !Number.isFinite(maxPct)) {
    throw new RangeError("hostedDamage: band multiplier overflow");
  }
  return { minPct, maxPct };
}

export function soulCrushHostedBand(band: DamageBand, residualSouls: number): DamageBand {
  if (!Number.isSafeInteger(residualSouls) || residualSouls < 0 || residualSouls > 5) {
    throw new RangeError("hostedDamage: invalid Soul Crush residual souls");
  }
  return scaleHostedBand(band, 1 + residualSouls);
}

export function deathSparkHostedBand(band: DamageBand, empowered: boolean): DamageBand {
  if (typeof empowered !== "boolean") throw new TypeError("hostedDamage: invalid Death Spark state");
  return scaleHostedBand(band, empowered ? DEATH_SPARK_DAMAGE_MULT : 1);
}

export function skeletonRageHostedBand(band: DamageBand, rageStacks: number): DamageBand {
  return scaleHostedBand(band, skeletonRageMult(rageStacks));
}

/** Reuses the exact sourced Haunted floor/cap program, including the Nexus
 * variant's floating-point order, rather than rebuilding the bonus in RS3. */
export function nexusHauntedBonus(
  parentDamage: number, capAbilityDamage: number,
  bonusPercent: number = HAUNTED_BONUS_PCT,
  capPercent: number = HAUNTED_CAP_PCT_OF_AD,
): number {
  finiteNonnegative(parentDamage, "Haunted host damage");
  finiteNonnegative(capAbilityDamage, "Haunted cap ability damage");
  finiteNonnegative(bonusPercent, "Haunted bonus percent");
  finiteNonnegative(capPercent, "Haunted cap percent");
  return hauntedBonusDamage(
    parentDamage * bonusPercent / HAUNTED_BONUS_PCT,
    capAbilityDamage * capPercent / HAUNTED_CAP_PCT_OF_AD,
  );
}

/** Blood Siphon pulse: nominal healing only. Host decides actual LP gained. */
export function bloodSiphonPulseNominal(damage: number, healingPercent: number): number {
  finiteNonnegative(damage, "Blood Siphon damage");
  finiteNonnegative(healingPercent, "Blood Siphon healing percent");
  return percentFloor(damage, healingPercent);
}

export function bonesAdjustedArmourRating(args: {
  readonly baseRating: number;
  readonly stacks: number;
  readonly reductionPercentPerStack: number;
  readonly rounding: HostedRounding | "none";
}): number {
  const { baseRating, stacks, reductionPercentPerStack, rounding } = args;
  finiteNonnegative(baseRating, "Bones armour");
  finiteNonnegative(reductionPercentPerStack, "Bones per-stack percent");
  if (!Number.isSafeInteger(stacks) || stacks < 0) {
    throw new RangeError("hostedDamage: invalid Bones stack count");
  }
  const result = baseRating * (100 - stacks * reductionPercentPerStack) / 100;
  if (!Number.isFinite(result) || result < 0) {
    throw new RangeError("hostedDamage: invalid adjusted Bones rating");
  }
  return rounding === "none" ? result : rounded(result, rounding);
}

/** Pure incoming percentage modifiers; phase/eligibility and active buffs
 * remain host decisions. Keep separate game rounding stages. */
export function hostedDamageMultiplier(
  damage: number, multiplier: number, mode: HostedRounding = "floor",
): number {
  finiteNonnegative(damage, "incoming damage");
  finiteNonnegative(multiplier, "incoming multiplier");
  return rounded(damage * multiplier, mode);
}

export function hostedReflectReduction(damage: number, retainedFraction: number): {
  readonly damage: number; readonly prevented: number;
} {
  finiteNonnegative(damage, "Reflect incoming damage");
  if (!Number.isFinite(retainedFraction) || retainedFraction < 0 || retainedFraction > 1) {
    throw new RangeError("hostedDamage: invalid Reflect retained fraction");
  }
  const prevented = floorDamage(damage * (1 - retainedFraction));
  return { damage: damage - prevented, prevented };
}

/** Preserve the host's exact defence/equipment multiplier order and floors.
 * The host decides which layers are eligible, never the calculator. */
export function hostedMitigationDamage(input: {
  readonly damage: number;
  readonly eligible: boolean;
  readonly defenceReduction: number;
  readonly equipmentReduction: number;
  readonly stacking: "additive" | "multiplicative";
  readonly roundingStage: "final" | "per_layer";
  readonly rounding: HostedRounding;
  readonly minimumDamage: number;
}): number {
  finiteNonnegative(input.damage, "mitigation incoming damage");
  finiteNonnegative(input.minimumDamage, "mitigation minimum");
  for (const v of [input.defenceReduction, input.equipmentReduction]) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new RangeError("hostedDamage: invalid mitigation reduction");
    }
  }
  if (!input.eligible) return input.damage;
  let remaining = input.damage;
  if (input.stacking === "additive") {
    remaining *= 1 - Math.min(1, input.defenceReduction + input.equipmentReduction);
  } else if (input.stacking === "multiplicative") {
    remaining *= 1 - input.equipmentReduction;
    if (input.roundingStage === "per_layer") remaining = rounded(remaining, input.rounding);
    else if (input.roundingStage !== "final") throw new RangeError("hostedDamage: invalid mitigation stage");
    remaining *= 1 - input.defenceReduction;
  } else throw new RangeError("hostedDamage: invalid mitigation stacking");
  remaining = rounded(remaining, input.rounding);
  if (input.damage > 0) {
    remaining = Math.max(Math.min(input.damage, input.minimumDamage), remaining);
  }
  return remaining;
}

export function hostedResonanceHealing(
  damage: number, shieldTier: number, basePercent: number,
  percentPerTier: number, mode: HostedRounding,
): number {
  finiteNonnegative(damage, "Resonance incoming damage");
  finiteNonnegative(shieldTier, "Resonance shield tier");
  finiteNonnegative(basePercent, "Resonance base percent");
  finiteNonnegative(percentPerTier, "Resonance per-tier percent");
  const percent = Math.min(100, basePercent + percentPerTier * shieldTier);
  // Sourced Resonance's current game rule uses Math.floor (not the
  // float-near-integer rounding guard) at this stage.
  if (mode === "floor") return Math.floor(damage * percent / 100);
  if (mode === "round") return Math.round(damage * percent / 100);
  throw new RangeError("hostedDamage: invalid Resonance rounding");
}


/** Source-based incoming mitigation: only numerical composition is owned here. */
export function hostedReductionFromTier(tier: number, percentPerTier: number): number {
  finiteNonnegative(tier, "mitigation tier");
  finiteNonnegative(percentPerTier, "mitigation percent per tier");
  return Math.min(1, tier * percentPerTier / 100);
}
export function hostedEquipmentReduction(
  reductions: readonly number[], stacking: "sum" | "multiplicative",
): number {
  for (const reduction of reductions) {
    if (!Number.isFinite(reduction) || reduction < 0 || reduction > 1) {
      throw new RangeError("hostedDamage: invalid equipment mitigation");
    }
  }
  if (stacking === "sum") return Math.min(1, reductions.reduce((sum, x) => sum + x, 0));
  if (stacking === "multiplicative") return 1 - reductions.reduce((part, x) => part * (1 - x), 1);
  throw new RangeError("hostedDamage: invalid equipment stacking");
}
export function hostedCombinedReduction(
  defenceReduction: number, equipmentReduction: number,
  stacking: "additive" | "multiplicative",
): number {
  for (const x of [defenceReduction, equipmentReduction]) {
    if (!Number.isFinite(x) || x < 0 || x > 1) throw new RangeError("hostedDamage: invalid reduction");
  }
  if (stacking === "additive") return Math.min(1, defenceReduction + equipmentReduction);
  if (stacking === "multiplicative") return 1 - (1 - defenceReduction) * (1 - equipmentReduction);
  throw new RangeError("hostedDamage: invalid defence stacking");
}
export function hostedPrayerRetainedMultiplier(
  baseMultiplier: number, bonusPercentagePoints: number,
): number {
  if (!Number.isFinite(baseMultiplier) || baseMultiplier < 0 || baseMultiplier > 1 ||
      !Number.isFinite(bonusPercentagePoints) || bonusPercentagePoints < 0) {
    throw new RangeError("hostedDamage: invalid protection prayer modifier");
  }
  return Math.max(0, (baseMultiplier * 100 - bonusPercentagePoints) / 100);
}
export function hostedResonanceFraction(
  shieldTier: number, basePercent: number, percentPerTier: number,
): number {
  finiteNonnegative(shieldTier, "resonance shield tier");
  finiteNonnegative(basePercent, "resonance base percentage");
  finiteNonnegative(percentPerTier, "resonance percentage per tier");
  return Math.min(100, basePercent + percentPerTier * shieldTier) / 100;
}


/** Last host-consumed weapon and secondary-target damage bands.
 * The numeric values come from the previously source-attributed RS3 ability
 * records; this is their ONE canonical definition after the integration.
 * Impact timing, targets and soul stacks remain owned by the encounter.
 * These values have NOT been independently calibrated against live game traces.
 */
export const DEATH_ESSENCE_DAMAGE_BAND: Readonly<DamageBand> = Object.freeze({ minPct: 360, maxPct: 440 });
export const SOUL_CRUSH_DAMAGE_BAND: Readonly<DamageBand> = Object.freeze({ minPct: 135, maxPct: 165 });
export const SOUL_STRIKE_SECONDARY_DAMAGE_BAND: Readonly<DamageBand> = Object.freeze({ minPct: 90, maxPct: 110 });

/** Source: RuneScape Wiki Death Mark, previously implemented by the Equilibrium
 * engine/deathMark resolver. Reused by RS3 without invoking Equilibrium HP logic.
 */
export const DEATH_MARK_DURATION_TICKS = 1000;
export const DEATH_MARK_EXECUTION_FRACTION = 0.2;
export const DEATH_MARK_EXECUTION_THRESHOLD = 30000;
export const DEATH_MARK_EXECUTION_DAMAGE = 100000;

export function hostedDeathMarkThreshold(maxHp: number): number {
  if (!Number.isSafeInteger(maxHp) || maxHp <= 0) throw new RangeError("Invalid Death Mark max HP");
  return Math.min(maxHp * DEATH_MARK_EXECUTION_FRACTION, DEATH_MARK_EXECUTION_THRESHOLD);
}
export function hostedDeathMarkWindow(hp: number, maxHp: number): boolean {
  if (!Number.isSafeInteger(hp) || hp < 0 || hp > maxHp) throw new RangeError("Invalid Death Mark HP");
  return hp > 0 && hp < hostedDeathMarkThreshold(maxHp);
}

/** Nominal Life Transfer cost only; RS3 owns eligibility, HP and event timing. */
export function lifeTransferSelfDamage(baseHp: number): number {
  if (!Number.isSafeInteger(baseHp) || baseHp <= 0) throw new RangeError("Invalid Life Transfer base HP");
  return floorDamage(baseHp / 2);
}

/** Unicorn heal arithmetic only; RS3 owns healing points and familiar commands. */
export function unicornHealNominal(maxHp: number, healPercent: number): number {
  if (!Number.isSafeInteger(maxHp) || maxHp <= 0) throw new RangeError("Invalid Unicorn maximum HP");
  finiteNonnegative(healPercent, "Unicorn heal percentage");
  if (healPercent > 100) throw new RangeError("Invalid Unicorn heal percentage");
  return percentFloor(maxHp, healPercent);
}
