import { bandOf, type DamageBand } from "../core/abilityDamage";
import {
  baseCritDamageMultiplier,
  critProbability,
  discreteUniformCritDamageValues,
  type CritLayers,
  type DiscreteUniformCritDamageLayer,
} from "../core/critical";
import { applyDamagePotential, damagePotential } from "../core/damagePotential";
import { applyHitCap, normalizeHitCapRule, standardHitCap, type HitCapRule } from "../core/hitCaps";
import { resolveHostDamageInstance } from "../core/hostDamage";
import { floorDamage, mulFloor } from "../core/rounding";
import {
  contextWithProvenance,
  isTrueDotDamage,
  type DamageProvenance,
} from "../shared/damageProvenance";
import { preciseMinHitAddition } from "../shared/perks";
import {
  recordEndpointPass,
  recordHitExpectationCall,
  recordIntegerBandPoints,
} from "../profiling/hitPipeline";
import {
  applyAbilityBaseModifiers,
  compileActiveModifiers,
  runOrderedPipeline,
} from "./modifierPipeline";
import type { CombatContext, CombatModifier } from "../types";

export interface HitInput {
  /** Caller-supplied base ability damage (weapon + level composition lives outside the engine). */
  base: number;
  band: DamageBand;
  /** Style level, feeds the crit damage layer. */
  level: number;
  /** Accuracy 0..1, applied as Damage Potential. */
  accuracy: number;
  crit: CritLayers;
  /** Damage-only crit layer; every point uses the normal floor/cap pipeline. */
  critDamageDistribution?: DiscreteUniformCritDamageLayer;
  context?: CombatContext;
  /** Explicit provenance; merged into context when set (preferred over legacy flags alone). */
  provenance?: DamageProvenance;
  modifiers?: CombatModifier[];
  cap?: HitCapRule;
  /** Precise perk rank 1-6; raises min hit by 1.5% of max per rank. */
  preciseRank?: number;
  /** Integer added after Damage Potential and before the hit cap. */
  postDamagePotentialFlat?: number;
  /** Late flat damage that inherits this hit's critical outcome, then shares its hit cap. */
  postDamagePotentialCritFlat?: number;
}

export interface HitResult {
  potential: number;
  min: number;
  max: number;
  critMin: number;
  critMax: number;
  critChance: number;
  critDamageBonus?: number;
  nonCritExpected: number;
  critExpected: number;
  /** Chance-weighted mean across crit and non-crit, Damage-Potential-scaled and capped. */
  expected: number;
  /** Same expectation before the hit cap, for analysis attribution. */
  uncappedExpected: number;
  capLoss: number;
  /** Expected marginal damage from the post-Damage-Potential flat term after the cap. */
  postDamagePotentialFlatContribution?: number;
  /** Concrete land-time outcome; absent on deterministic expected-value hit details. */
  critOutcome?: boolean;
}

export interface ExactDamageDistribution {
  damage: number;
  weight: number;
}

export interface RawHitBandInput extends Omit<HitInput, "base" | "band"> {
  min: number;
  max: number;
}

export interface AttachedRawDamage {
  id: string;
  amount: number;
}

export interface AttachedHitDelta {
  id: string;
  hit: HitResult;
}

export interface ComposedHitResult {
  hit: HitResult;
  baseHit: HitResult;
  attached: readonly AttachedHitDelta[];
}

type SharedHitInput = Omit<HitInput, "base" | "band">;

/** Pre-compiled, sorted + filtered modifier lists for one hit expectation. */
interface HitPassKits {
  context: CombatContext;
  nonCrit: readonly CombatModifier[];
  /** Present only when crit path is live (p > 0 / guaranteed). */
  crit: readonly CombatModifier[] | null;
  accuracy: number;
  capRule: HitCapRule;
  postDamagePotentialFlat: number;
  postDamagePotentialCritFlat: number;
}

// Soft player_direct default inside contextWithProvenance is unit-test only.
// Engine land paths (castHit, conjures, lightningSurge, league) pass provenance.
function resolvedHitContext(input: SharedHitInput): CombatContext {
  return contextWithProvenance(input.context, input.provenance);
}

/**
 * Compile non-crit and (optional) crit ordered active lists once per hit context.
 * Same identity as per-roll orderModifiers + filter: stage then priority, then applies.
 */
function compileHitPassKits(input: SharedHitInput, critLive: boolean | null): HitPassKits {
  const context = resolvedHitContext(input);
  const baseMods = input.modifiers ?? [];
  const nonCrit = compileActiveModifiers(baseMods, context);
  const postDamagePotentialFlat = input.postDamagePotentialFlat ?? 0;
  const postDamagePotentialCritFlat = input.postDamagePotentialCritFlat ?? 0;
  if (!Number.isInteger(postDamagePotentialFlat) || postDamagePotentialFlat < 0) {
    throw new RangeError(
      `calculateHit: postDamagePotentialFlat must be a non-negative integer, got ${postDamagePotentialFlat}`,
    );
  }
  if (!Number.isInteger(postDamagePotentialCritFlat) || postDamagePotentialCritFlat < 0) {
    throw new RangeError(
      `calculateHit: postDamagePotentialCritFlat must be a non-negative integer, got ${postDamagePotentialCritFlat}`,
    );
  }
  return {
    context,
    nonCrit,
    crit: critLive ? nonCrit : null,
    accuracy: input.accuracy,
    capRule: normalizeHitCapRule(input.cap ?? standardHitCap),
    postDamagePotentialFlat,
    postDamagePotentialCritFlat,
  };
}

function runPass(
  damage: number,
  orderedActive: readonly CombatModifier[],
  kits: HitPassKits,
  cap = true,
  criticalDamageMultiplier?: number | null,
  hostRounding?: "rs3-host",
): number {
  // Pre-filtered + ordered once per pass kind; apply chain identical to runPipeline.
  const state = runOrderedPipeline(
    { damage },
    orderedActive,
    kits.context,
    true,
    criticalDamageMultiplier ?? undefined,
    hostRounding,
  );
  const scaled = applyDamagePotential(state.damage, kits.accuracy);
  const inheritedCritFlat =
    criticalDamageMultiplier == null
      ? kits.postDamagePotentialCritFlat
      : mulFloor(kits.postDamagePotentialCritFlat, criticalDamageMultiplier);
  const resolved = (hostRounding === "rs3-host" ? floorDamage(scaled) : Math.floor(scaled)) +
    kits.postDamagePotentialFlat + inheritedCritFlat;
  return cap ? applyHitCap(resolved, kits.capRule) : resolved;
}

function activeFor(kits: HitPassKits, critMult: number | null): readonly CombatModifier[] {
  if (critMult === null) return kits.nonCrit;
  return kits.crit ?? kits.nonCrit;
}

export const MAX_EXACT_BAND_POINTS = 100_001;

/**
 * Inclusive integer-band mean for the exact oracle path.
 * Walks every roll; each roll reuses pre-ordered modifiers (no re-sort).
 * Floor chain, DP, and cap remain per-roll; never collapsed to a single product.
 */
function exactMean(
  min: number,
  max: number,
  critMult: number | null,
  kits: HitPassKits,
  cap = true,
): number {
  const count = max - min + 1;
  if (count > MAX_EXACT_BAND_POINTS) {
    throw new RangeError(
      `calculateHit: exact integer band has ${count} points (limit ${MAX_EXACT_BAND_POINTS})`,
    );
  }
  recordIntegerBandPoints(count);
  const ordered = activeFor(kits, critMult);
  let total = 0;
  for (let roll = min; roll <= max; roll++) {
    total += runPass(roll, ordered, kits, cap, critMult);
  }
  return total / count;
}

/**
 * Single hit: band roll -> modifier pipeline -> crit layer -> Damage Potential -> cap.
 * Crit runs as a second pass with the crit damage multiplier injected at the critical
 * stage, so crit-only modifiers see exactly one code path. Expected damage enumerates
 * the inclusive uniform integer band, preserving every floor and partial cap exactly.
 */
export function calculateHit(input: HitInput): HitResult {
  const context = resolvedHitContext(input);
  const prepared = applyAbilityBaseModifiers(input.base, input.modifiers ?? [], context);
  const { min, max } = rawHitBand({
    ...input,
    base: prepared.base,
    modifiers: prepared.modifiers,
  });
  return calculateRawHitBand({
    ...input,
    min,
    max,
    modifiers: prepared.modifiers,
  });
}

function rawHitBand(input: HitInput): { min: number; max: number } {
  const band = bandOf(input.base, input.band);
  let min = band.min;
  const max = band.max;
  const precise = input.preciseRank ?? 0;
  // Wiki Precise: DoTs ignore Precise. Converted channels keep it (not true DoTs).
  // Bloat parent is player_direct so it still receives Precise; tails are derived fractions.
  if (precise > 0 && !isTrueDotDamage(resolvedHitContext(input))) {
    min = Math.min(max, Math.floor(min + preciseMinHitAddition(max, precise)));
  }
  return { min, max };
}

function hitDelta(after: HitResult, before: HitResult): HitResult {
  return {
    potential: after.potential,
    min: after.min - before.min,
    max: after.max - before.max,
    critMin: after.critMin - before.critMin,
    critMax: after.critMax - before.critMax,
    critChance: after.critChance,
    critDamageBonus: after.critDamageBonus,
    nonCritExpected: after.nonCritExpected - before.nonCritExpected,
    critExpected: after.critExpected - before.critExpected,
    expected: after.expected - before.expected,
    uncappedExpected: after.uncappedExpected - before.uncappedExpected,
    capLoss: after.capLoss - before.capLoss,
    ...(after.postDamagePotentialFlatContribution !== undefined ||
    before.postDamagePotentialFlatContribution !== undefined
      ? {
          postDamagePotentialFlatContribution:
            (after.postDamagePotentialFlatContribution ?? 0) -
            (before.postDamagePotentialFlatContribution ?? 0),
        }
      : {}),
  };
}

/**
 * Resolve deterministic attached terms inside one host hit. Each marginal delta
 * uses the same modifier, crit, Damage Potential, floor, and hit-cap program.
 */
export function calculateHitWithAttached(
  input: HitInput,
  attached: readonly AttachedRawDamage[],
): ComposedHitResult {
  const context = resolvedHitContext(input);
  const prepared = applyAbilityBaseModifiers(input.base, input.modifiers ?? [], context);
  const raw = rawHitBand({
    ...input,
    base: prepared.base,
    modifiers: prepared.modifiers,
  });
  const shared: RawHitBandInput = {
    ...input,
    modifiers: prepared.modifiers,
    min: raw.min,
    max: raw.max,
  };
  delete (shared as Partial<HitInput>).preciseRank;
  return calculateRawHitBandWithAttached(shared, attached);
}

export function calculateRawHitBandWithAttached(
  input: RawHitBandInput,
  attached: readonly AttachedRawDamage[],
): ComposedHitResult {
  const resolved = resolveHostDamageInstance(
    { host: { min: input.min, max: input.max }, attached },
    {
      add: (host, amount) => ({ min: host.min + amount, max: host.max + amount }),
      resolve: (host) => calculateRawHitBand({ ...input, ...host }),
      delta: hitDelta,
    },
  );
  return {
    hit: resolved.damage,
    baseHit: resolved.hostDamage,
    attached: resolved.attached.map(({ term, damage }) => ({ id: term.id, hit: damage })),
  };
}

function assertIntegerBandBounds(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new RangeError(`calculateRawHitBand: non-finite band ${min}-${max}`);
  }
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new RangeError(`calculateRawHitBand: non-integer band ${min}-${max}`);
  }
  if (min < 0) {
    throw new RangeError(`calculateRawHitBand: negative minimum ${min}`);
  }
  if (min > max) {
    throw new RangeError(`calculateRawHitBand: inverted band ${min}-${max}`);
  }
}

function normalizeExactDamageDistribution(
  grouped: Map<number, number>,
  count: number,
): readonly ExactDamageDistribution[] {
  if (grouped.size === 0 || count < 1) {
    throw new RangeError("calculateHit: exact noncritical distribution has no mass");
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([damage, occurrences]) => ({ damage, weight: occurrences / count }));
}

export function calculateRawNonCriticalHitDistribution(
  input: RawHitBandInput,
): readonly ExactDamageDistribution[] {
  recordHitExpectationCall();
  assertIntegerBandBounds(input.min, input.max);
  const count = input.max - input.min + 1;
  if (count > MAX_EXACT_BAND_POINTS) {
    throw new RangeError(
      `calculateHit: exact integer band has ${count} points (limit ${MAX_EXACT_BAND_POINTS})`,
    );
  }
  recordIntegerBandPoints(count);
  const kits = compileHitPassKits(input, false);
  const grouped = new Map<number, number>();
  for (let roll = input.min; roll <= input.max; roll++) {
    const damage = runPass(roll, kits.nonCrit, kits);
    grouped.set(damage, (grouped.get(damage) ?? 0) + 1);
  }
  return normalizeExactDamageDistribution(grouped, count);
}

export function calculateNonCriticalHitDistribution(
  input: HitInput,
): readonly ExactDamageDistribution[] {
  const context = resolvedHitContext(input);
  const prepared = applyAbilityBaseModifiers(input.base, input.modifiers ?? [], context);
  const raw = rawHitBand({
    ...input,
    base: prepared.base,
    modifiers: prepared.modifiers,
  });
  const { base: _base, band: _band, ...shared } = input;
  return calculateRawNonCriticalHitDistribution({
    ...shared,
    min: raw.min,
    max: raw.max,
    modifiers: prepared.modifiers,
    crit: { ...input.crit, chance: 0, guaranteed: false, eligible: false },
  });
}

/** Resolve an already-composed inclusive integer band through the normal hit pipeline. */
export function calculateRawHitBand(input: RawHitBandInput): HitResult {
  recordHitExpectationCall();
  assertIntegerBandBounds(input.min, input.max);
  if (input.cap) normalizeHitCapRule(input.cap);
  const p = critProbability(input.crit);

  const nonCritKits = compileHitPassKits(input, p > 0);
  const critBonuses =
    p > 0
      ? input.critDamageDistribution
        ? discreteUniformCritDamageValues(input.critDamageDistribution).map(
            (bonus) => (input.crit.damageBonus ?? 0) + bonus,
          )
        : [input.crit.damageBonus ?? 0]
      : [];
  const critPasses = critBonuses.map((damageBonus) => ({
    kits: nonCritKits,
    critMult: baseCritDamageMultiplier(input.level, damageBonus),
  }));
  const nonCritMods = nonCritKits.nonCrit;

  // Endpoint probes (bound display / cap probe).
  recordEndpointPass(2);
  const min = runPass(input.min, nonCritMods, nonCritKits);
  const max = runPass(input.max, nonCritMods, nonCritKits);
  let critMin = min;
  let critMax = max;
  if (critPasses.length > 0) {
    recordEndpointPass(2 * critPasses.length);
    critMin = Math.min(
      ...critPasses.map(({ kits, critMult }) =>
        runPass(input.min, kits.crit!, kits, true, critMult),
      ),
    );
    critMax = Math.max(
      ...critPasses.map(({ kits, critMult }) =>
        runPass(input.max, kits.crit!, kits, true, critMult),
      ),
    );
  }
  const nonCritExpected = exactMean(input.min, input.max, null, nonCritKits);
  const critExpected =
    critPasses.length === 0
      ? nonCritExpected
      : critPasses.reduce(
          (total, { kits, critMult: variantMult }) =>
            total + exactMean(input.min, input.max, variantMult, kits),
          0,
        ) / critPasses.length;
  const expected = (1 - p) * nonCritExpected + p * critExpected;
  const postDamagePotentialFlatContribution =
    nonCritKits.postDamagePotentialFlat > 0
      ? (() => {
          const baselineKits = { ...nonCritKits, postDamagePotentialFlat: 0 };
          const baselineNonCritExpected = exactMean(
            input.min,
            input.max,
            null,
            baselineKits,
          );
          const baselineCritExpected =
            critPasses.length === 0
              ? baselineNonCritExpected
              : critPasses.reduce(
                  (total, { critMult: variantMult }) =>
                    total + exactMean(input.min, input.max, variantMult, baselineKits),
                  0,
                ) / critPasses.length;
          const baselineExpected =
            (1 - p) * baselineNonCritExpected + p * baselineCritExpected;
          return Math.max(0, expected - baselineExpected);
        })()
      : undefined;
  const capRule = nonCritKits.capRule;
  recordEndpointPass(2);
  const uncappedMaxNonCrit = runPass(input.max, nonCritMods, nonCritKits, false);
  const uncappedMaxCrit =
    critPasses.length === 0
      ? uncappedMaxNonCrit
      : Math.max(
          ...critPasses.map(({ kits, critMult }) =>
            runPass(input.max, kits.crit!, kits, false, critMult),
          ),
        );
  const canClip = !capRule.bypass && Math.max(uncappedMaxNonCrit, uncappedMaxCrit) > capRule.cap;
  const uncappedExpected = canClip
    ? (1 - p) * exactMean(input.min, input.max, null, nonCritKits, false) +
      p *
        (critPasses.length === 0
          ? nonCritExpected
          : critPasses.reduce(
              (total, { kits, critMult: variantMult }) =>
                total + exactMean(input.min, input.max, variantMult, kits, false),
              0,
            ) / critPasses.length)
    : expected;

  return {
    potential: damagePotential(input.accuracy),
    min,
    max,
    critMin,
    critMax,
    critChance: p,
    critDamageBonus:
      (input.crit.damageBonus ?? 0) +
      (input.critDamageDistribution
        ? (input.critDamageDistribution.minBonus + input.critDamageDistribution.maxBonus) / 2
        : 0),
    nonCritExpected,
    critExpected,
    expected,
    uncappedExpected,
    capLoss: Math.max(0, uncappedExpected - expected),
    ...(postDamagePotentialFlatContribution !== undefined
      ? { postDamagePotentialFlatContribution }
      : {}),
  };
}

/**
 * A single concrete combat hit using the EXACT modifier, critical, Damage
 * Potential and cap program used for the statistical hit distribution.
 *
 * The host owns the seeded RNG stream and supplies it explicitly. This
 * function does not enumerate an expected hit band or consume the model's
 * RNG during legality/preview queries. For an eligible non-guaranteed hit it
 * draws critical chance first, then one inclusive integer damage roll,
 * mirroring the established RS3 Combat Lab stream ordering.
 */
export interface RealizedHitInput extends HitInput {
  readonly random: () => number;
  /** Opt-in legacy host numerical guard; generic Equilibrium floor stays unchanged. */
  readonly hostRounding?: "rs3-host";
}

export interface RealizedHit {
  readonly damage: number;
  readonly uncappedDamage: number;
  readonly crit: boolean;
  readonly rawRoll: number;
  readonly potential: number;
}

export function sampleRealizedHit(input: RealizedHitInput): RealizedHit {
  if (input.critDamageDistribution !== undefined) {
    throw new RangeError(
      "sampleRealizedHit: damage-only crit distributions require an explicit roll contract",
    );
  }
  const context = resolvedHitContext(input);
  const prepared = applyAbilityBaseModifiers(input.base, input.modifiers ?? [], context);
  const { min, max } = rawHitBand({
    ...input,
    base: prepared.base,
    modifiers: prepared.modifiers,
  });
  assertIntegerBandBounds(min, max);
  const draw = (): number => {
    const value = input.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("sampleRealizedHit: RNG must produce values in [0, 1)");
    }
    return value;
  };

  // Even p=0 consumes its one crit roll on an eligible non-guaranteed hit.
  // For guaranteed/disabled/DoT hits, the crit RNG draw is not needed.
  const p = critProbability(input.crit);
  const crit = input.crit.eligible === false || input.crit.disabled
    ? false
    : input.crit.guaranteed
      ? true
      : draw() < p;
  const rawRoll = min + Math.floor(draw() * (max - min + 1));
  const kits = compileHitPassKits(
    { ...input, modifiers: prepared.modifiers },
    crit,
  );
  const mult = crit ? baseCritDamageMultiplier(input.level, input.crit.damageBonus ?? 0) : null;
  const active = activeFor(kits, mult);
  const uncappedDamage = runPass(rawRoll, active, kits, false, mult, input.hostRounding);
  const damage = runPass(rawRoll, active, kits, true, mult, input.hostRounding);
  return {
    damage,
    uncappedDamage,
    crit,
    rawRoll,
    potential: damagePotential(input.accuracy),
  };
}
