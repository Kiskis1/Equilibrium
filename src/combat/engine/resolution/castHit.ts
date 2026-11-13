import {
  baseCritDamageMultiplier,
  critProbability,
  discreteUniformCritDamageValues,
  type CritLayers,
  type DiscreteUniformCritDamageLayer,
} from "../../core/critical";
import { bandOf } from "../../core/abilityDamage";
import { applyHitCap, normalizeHitCapRule, standardHitCap } from "../../core/hitCaps";
import type { AbilityHit, AbilitySpec } from "../../pipeline/calculateAbility";
import {
  calculateHit,
  calculateNonCriticalHitDistribution,
  type ExactDamageDistribution,
  type HitResult,
} from "../../pipeline/calculateHit";
import {
  applyAbilityBaseModifiers,
  compileActiveModifiers,
  runOrderedPipeline,
} from "../../pipeline/modifierPipeline";
import { applyDamagePotential } from "../../core/damagePotential";
import { preciseMinHitAddition } from "../../shared/perks";
import { eofReaperBonus, isEofEquipped, isEofReaperHitEligible } from "../../shared/eofPassives";
import { TUSKAS_EMPOWERED_HIT_CAP } from "../../styles/shared/constitutionAbilities";
import { bashRawDamageBand } from "../../styles/shared/defenceAbilities";
import { FURY_CRIT_CHANCE_BONUS } from "../../styles/melee/effects";
import {
  channelledMightCritBonus,
  isConcentratedBlast,
  sunshineActive,
} from "../../styles/magic/effects";
import { SEARING_WINDS_BONUS_HIT_PCT } from "../../styles/ranged/onHit";
import { resolveRangedAmmunitionHitEffects } from "../../styles/ranged/ammunitionPayloads";
import { enchantedBoltActivationChance } from "../../styles/ranged/enchantedBolt";
import { enchantedBoltStatefulProcStream } from "../../styles/ranged/enchantedBoltRuntime";
import { isAmmunitionHitEligible } from "../../styles/ranged/ammunitionEligibility";
import { chromaticChoirActive } from "../../styles/ranged/chromaticChoir";
import { dracolichInfusionCritChance } from "../../styles/ranged/dracolich";
import { WEN_ICY_PRECISION_DAMAGE_POTENTIAL_DELTA } from "../../styles/ranged/wen";
import {
  COMMAND_REQUIRES_CONJURE,
  conjureEligibleModifiers,
  findConjure,
  skeletonRageMult,
} from "../../styles/necromancy/conjures";
import {
  hauntedActive,
  hauntedBonusDamage,
  hauntedParentDamage,
} from "../../styles/necromancy/haunted";
import {
  capabilitiesOf,
  isTrueDotDamage,
  outgoingSourceOf,
  provenanceForCastHit,
} from "../../shared/damageProvenance";
import { isBasicAttack } from "../../shared/adrenalineGain";
import type { CastSnapshot } from "../cast/snapshot";
import type { SimulationRuntime } from "../runtime/runtime";
import { landTimeModifiers } from "./modifiers";
import {
  packageCritical,
  type AttachedDamageComponent,
  type EventResolution,
  type ResolvedDamage,
} from "./types";
import { SURGING_STORM_CRIT_DAMAGE_DISTRIBUTION } from "../../styles/magic/effects";
import { dynamicEquipmentCritBonus } from "../../shared/equipment";
import { activeBleedCount } from "../../styles/melee/effects";
import { activeFrostbladesMass } from "../../styles/melee/primordialIce";
import { hitReuseGet, hitReuseSet, isHitReuseActive } from "./hitReuse";
import { landHitIdentity } from "./landHitIdentity";
import { resolveEffectiveCombatLevel } from "../../core/effectiveLevel";
import { NARAGI_LEVEL_OVERRIDE } from "../../league/naragiEdict";
import {
  attachedResolutionComponent,
  resolveLeagueAttachedHost,
  resolveLeagueAttachedRawHost,
} from "../../league/damage";
import { recordResolutionCache } from "../../profiling/hitPipeline";
import { resolveLeagueCritAtLand } from "../../league/ruleset";
import { liveTargetDamagePotential as resolveLiveTargetDamagePotential } from "../../target/genericTarget";
import {
  NO_SONG_OF_DESTRUCTION,
  essenceCorruptionFlatBonus,
} from "../../styles/magic/songOfDestruction";
import {
  ATTUNED_CRYSTAL_COMPONENT_ID,
  attunedCrystalExpectedBonus,
  isAttunedCrystalWeaponryHitEligible,
} from "../../shared/attunedCrystalWeaponry";

/** Style level at land tick: temporary override (e.g. Naragi 255) wins when active. */
function combatLevelAt(rt: SimulationRuntime, landTick: number): number {
  return resolveEffectiveCombatLevel(rt.input.level, rt.state.player?.levelOverride, landTick);
}

/** Base AD at land tick: use overrideBase when effective level is the override level. */
function combatBaseAt(rt: SimulationRuntime, landTick: number, level: number): number {
  const overrideLevel = rt.input.overrideLevel ?? NARAGI_LEVEL_OVERRIDE;
  if (
    rt.input.overrideBase != null &&
    level === overrideLevel &&
    rt.state.player?.levelOverride &&
    landTick < rt.state.player.levelOverride.untilTick
  ) {
    return rt.input.overrideBase;
  }
  return rt.input.base;
}

export function abilityDamageAt(rt: SimulationRuntime, landTick: number): number {
  const level = combatLevelAt(rt, landTick);
  return combatBaseAt(rt, landTick, level);
}

export function poisonAbilityDamageAt(rt: SimulationRuntime, landTick: number): number {
  const level = combatLevelAt(rt, landTick);
  const overrideLevel = rt.input.overrideLevel ?? NARAGI_LEVEL_OVERRIDE;
  if (
    rt.input.poisonOverrideBase != null &&
    level === overrideLevel &&
    rt.state.player?.levelOverride &&
    landTick < rt.state.player.levelOverride.untilTick
  ) {
    return rt.input.poisonOverrideBase;
  }
  return rt.input.poisonBase ?? rt.input.base;
}

function mix(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}

function mixHit(a: HitResult, b: HitResult, weight: number): HitResult {
  return {
    potential: a.potential,
    min: mix(a.min, b.min, weight),
    max: mix(a.max, b.max, weight),
    critMin: mix(a.critMin, b.critMin, weight),
    critMax: mix(a.critMax, b.critMax, weight),
    critChance: a.critChance,
    critDamageBonus: mix(a.critDamageBonus ?? 0, b.critDamageBonus ?? 0, weight),
    nonCritExpected: mix(a.nonCritExpected, b.nonCritExpected, weight),
    critExpected: mix(a.critExpected, b.critExpected, weight),
    expected: mix(a.expected, b.expected, weight),
    uncappedExpected: mix(a.uncappedExpected, b.uncappedExpected, weight),
    capLoss: mix(a.capLoss, b.capLoss, weight),
    ...(a.postDamagePotentialFlatContribution !== undefined ||
    b.postDamagePotentialFlatContribution !== undefined
      ? {
          postDamagePotentialFlatContribution: mix(
            a.postDamagePotentialFlatContribution ?? 0,
            b.postDamagePotentialFlatContribution ?? 0,
            weight,
          ),
        }
      : {}),
  };
}

function mixDamage(a: ResolvedDamage, b: ResolvedDamage, weight: number): ResolvedDamage {
  return {
    min: mix(a.min, b.min, weight),
    max: mix(a.max, b.max, weight),
    expected: mix(a.expected, b.expected, weight),
    ...(a.critExpected !== undefined || b.critExpected !== undefined
      ? { critExpected: mix(a.critExpected ?? a.expected, b.critExpected ?? b.expected, weight) }
      : {}),
    ...(a.capLoss !== undefined || b.capLoss !== undefined
      ? { capLoss: mix(a.capLoss ?? 0, b.capLoss ?? 0, weight) }
      : {}),
    ...(a.critical && b.critical
      ? {
          critical: {
            ...a.critical,
            contribution: mix(a.critical.contribution, b.critical.contribution, weight),
          },
        }
      : a.critical
        ? { critical: a.critical }
        : b.critical
          ? { critical: b.critical }
          : {}),
  };
}

function mixComponents(
  a: readonly AttachedDamageComponent[] | undefined,
  b: readonly AttachedDamageComponent[] | undefined,
  weight: number,
): readonly AttachedDamageComponent[] | undefined {
  if (!a && !b) return undefined;
  const left = a ?? [];
  const right = b ?? [];
  return left.map((component, index) => {
    const other = right[index] ?? component;
    return {
      ...component,
      damage: mixDamage(component.damage, other.damage, weight),
      ...(component.hitDetail && other.hitDetail
        ? { hitDetail: mixHit(component.hitDetail, other.hitDetail, weight) }
        : {}),
    };
  });
}

function mixResolution(a: EventResolution, b: EventResolution, weight: number): EventResolution {
  const components = mixComponents(a.components, b.components, weight);
  return {
    damage: mixDamage(a.damage, b.damage, weight),
    ...(a.hitDetail && b.hitDetail ? { hitDetail: mixHit(a.hitDetail, b.hitDetail, weight) } : {}),
    ...(a.ammunitionSourceDistribution
      ? { ammunitionSourceDistribution: a.ammunitionSourceDistribution }
      : b.ammunitionSourceDistribution
        ? { ammunitionSourceDistribution: b.ammunitionSourceDistribution }
        : {}),
    ...(a.ammunitionOriginalDamagePotential !== undefined ||
    b.ammunitionOriginalDamagePotential !== undefined
      ? {
          ammunitionOriginalDamagePotential: mix(
            a.ammunitionOriginalDamagePotential ?? 0,
            b.ammunitionOriginalDamagePotential ?? 0,
            weight,
          ),
        }
      : {}),
    ...(a.postDamagePotentialFlatContribution !== undefined ||
    b.postDamagePotentialFlatContribution !== undefined
      ? {
          postDamagePotentialFlatContribution: mix(
            a.postDamagePotentialFlatContribution ?? 0,
            b.postDamagePotentialFlatContribution ?? 0,
            weight,
          ),
        }
      : {}),
    ...(components ? { components } : {}),
    ...(a.sourcePrecritDistribution
      ? { sourcePrecritDistribution: a.sourcePrecritDistribution }
      : b.sourcePrecritDistribution
        ? { sourcePrecritDistribution: b.sourcePrecritDistribution }
        : {}),
  };
}

function mixExactDamageDistributions(
  inactive: readonly ExactDamageDistribution[],
  active: readonly ExactDamageDistribution[],
  activeWeight: number,
): readonly ExactDamageDistribution[] {
  const weights = new Map<number, number>();
  for (const outcome of inactive) {
    weights.set(
      outcome.damage,
      (weights.get(outcome.damage) ?? 0) + outcome.weight * (1 - activeWeight),
    );
  }
  for (const outcome of active) {
    weights.set(outcome.damage, (weights.get(outcome.damage) ?? 0) + outcome.weight * activeWeight);
  }
  return [...weights]
    .filter(([, weight]) => weight > 0)
    .sort(([left], [right]) => left - right)
    .map(([damage, weight]) => ({ damage, weight }));
}

function mixChanceResolution(
  inactive: EventResolution,
  active: EventResolution,
  activeWeight: number,
): EventResolution {
  const damage = mixDamage(inactive.damage, active.damage, activeWeight);
  const hitDetail =
    inactive.hitDetail && active.hitDetail
      ? {
          ...mixHit(inactive.hitDetail, active.hitDetail, activeWeight),
          min: Math.min(inactive.hitDetail.min, active.hitDetail.min),
          max: Math.max(inactive.hitDetail.max, active.hitDetail.max),
          critMin: Math.min(inactive.hitDetail.critMin, active.hitDetail.critMin),
          critMax: Math.max(inactive.hitDetail.critMax, active.hitDetail.critMax),
        }
      : undefined;
  const components = mixComponents(inactive.components, active.components, activeWeight)?.map(
    (component, index) => ({
      ...component,
      damage: {
        ...component.damage,
        min: Math.min(
          inactive.components?.[index]?.damage.min ?? component.damage.min,
          active.components?.[index]?.damage.min ?? component.damage.min,
        ),
        max: Math.max(
          inactive.components?.[index]?.damage.max ?? component.damage.max,
          active.components?.[index]?.damage.max ?? component.damage.max,
        ),
      },
    }),
  );
  const sourcePrecritDistribution =
    inactive.sourcePrecritDistribution && active.sourcePrecritDistribution
      ? mixExactDamageDistributions(
          inactive.sourcePrecritDistribution,
          active.sourcePrecritDistribution,
          activeWeight,
        )
      : undefined;
  return {
    damage: {
      ...damage,
      min: Math.min(inactive.damage.min, active.damage.min),
      max: Math.max(inactive.damage.max, active.damage.max),
    },
    ...(hitDetail ? { hitDetail } : {}),
    ...(inactive.ammunitionSourceDistribution
      ? { ammunitionSourceDistribution: inactive.ammunitionSourceDistribution }
      : active.ammunitionSourceDistribution
        ? { ammunitionSourceDistribution: active.ammunitionSourceDistribution }
        : {}),
    ...(inactive.postDamagePotentialFlatContribution !== undefined ||
    active.postDamagePotentialFlatContribution !== undefined
      ? {
          postDamagePotentialFlatContribution: mix(
            inactive.postDamagePotentialFlatContribution ?? 0,
            active.postDamagePotentialFlatContribution ?? 0,
            activeWeight,
          ),
        }
      : {}),
    ...(components ? { components } : {}),
    ...(sourcePrecritDistribution ? { sourcePrecritDistribution } : {}),
  };
}

function damageOnlyEnchantedBoltChance(
  rt: SimulationRuntime,
  ability: AbilitySpec,
  provenance: ReturnType<typeof provenanceForCastHit>,
): number | null {
  const mechanicId = rt.input.ammunition?.projectile?.mechanicId;
  if (
    mechanicId !== "opal" &&
    mechanicId !== "pearl" &&
    mechanicId !== "diamond" &&
    mechanicId !== "onyx"
  ) {
    return null;
  }
  if (mechanicId === "onyx" && (rt.state.player?.vitality.maximumLifePoints ?? 0) > 0) return null;
  if (
    mechanicId === "pearl" &&
    rt.input.targetClassification?.elementalWeakness !== "water" &&
    rt.input.targetClassification?.elementalWeakness !== "fire"
  ) {
    return null;
  }
  if (!isAmmunitionHitEligible({ style: ability.style, provenance, attackOrigin: "player" })) {
    return null;
  }
  return enchantedBoltActivationChance(mechanicId, rt.input.enchantedBoltChanceModifiers);
}

function ammunitionSourceDamageDistribution(args: {
  base: number;
  band: { minPct: number; maxPct: number };
  level: number;
  accuracy: number;
  crit: CritLayers;
  critDamageDistribution?: DiscreteUniformCritDamageLayer;
  modifiers: readonly import("../../types").CombatModifier[];
  context: import("../../types").CombatContext;
  cap?: import("../../core/hitCaps").HitCapRule;
  preciseRank?: number;
  postDamagePotentialFlat?: number;
}): readonly ExactDamageDistribution[] {
  const prepared = applyAbilityBaseModifiers(args.base, args.modifiers, args.context);
  const raw = bandOf(prepared.base, args.band);
  const precise = args.preciseRank ?? 0;
  const min =
    precise > 0 && !isTrueDotDamage(args.context)
      ? Math.min(raw.max, Math.floor(raw.min + preciseMinHitAddition(raw.max, precise)))
      : raw.min;
  const ordered = compileActiveModifiers(prepared.modifiers, args.context);
  const cap = normalizeHitCapRule(args.cap ?? standardHitCap);
  const postDamagePotentialFlat = args.postDamagePotentialFlat ?? 0;
  const resolve = (roll: number, critMultiplier?: number): number => {
    const state = runOrderedPipeline({ damage: roll }, ordered, args.context, true, critMultiplier);
    return applyHitCap(
      Math.floor(applyDamagePotential(state.damage, args.accuracy)) + postDamagePotentialFlat,
      cap,
    );
  };
  const points = raw.max - min + 1;
  const critChance = critProbability(args.crit);
  const critBonuses =
    critChance > 0
      ? args.critDamageDistribution
        ? discreteUniformCritDamageValues(args.critDamageDistribution).map(
            (bonus) => (args.crit.damageBonus ?? 0) + bonus,
          )
        : [args.crit.damageBonus ?? 0]
      : [];
  const grouped = new Map<number, number>();
  for (let roll = min; roll <= raw.max; roll += 1) {
    const rollWeight = 1 / points;
    if (critChance < 1) {
      const damage = resolve(roll);
      grouped.set(damage, (grouped.get(damage) ?? 0) + rollWeight * (1 - critChance));
    }
    if (critBonuses.length > 0) {
      const critWeight = (rollWeight * critChance) / critBonuses.length;
      for (const bonus of critBonuses) {
        const damage = resolve(roll, baseCritDamageMultiplier(args.level, bonus));
        grouped.set(damage, (grouped.get(damage) ?? 0) + critWeight);
      }
    }
  }
  return [...grouped]
    .filter(([, weight]) => weight > 0)
    .sort(([left], [right]) => left - right)
    .map(([damage, weight]) => ({ damage, weight }));
}

function statefulEnchantedBoltChance(
  rt: SimulationRuntime,
  ability: AbilitySpec,
  provenance: ReturnType<typeof provenanceForCastHit>,
): number | null {
  const mechanicId = rt.input.ammunition?.projectile?.mechanicId;
  const hasTargetState = (rt.state.target.vitality?.maximumLifePoints ?? 0) > 0;
  const hasPlayerState = (rt.state.player?.vitality.maximumLifePoints ?? 0) > 0;
  if (mechanicId === "ruby" && !hasTargetState) return null;
  if (mechanicId === "onyx" && !hasPlayerState) return null;
  if (mechanicId !== "ruby" && mechanicId !== "onyx") return null;
  if (!isAmmunitionHitEligible({ style: ability.style, provenance, attackOrigin: "player" })) {
    return null;
  }
  return enchantedBoltActivationChance(mechanicId, rt.input.enchantedBoltChanceModifiers);
}

function sourceDistributionForPerfectEquilibrium(args: {
  ability: AbilitySpec;
  snap: CastSnapshot;
  isDot: boolean;
  convertedChannel: boolean;
  provenance: ReturnType<typeof provenanceForCastHit>;
}): boolean {
  if (args.ability.style !== "ranged" || args.isDot || args.convertedChannel) return false;
  const capabilities = capabilitiesOf(args.provenance);
  return (
    (args.snap.perfectEquilibriumAtCast && capabilities.canGeneratePerfectEquilibrium === true) ||
    (args.ability.id === "balance_by_force" && args.snap.perfectEquilibriumTrigger === true)
  );
}

function validatePerfectEquilibriumSourceDistribution(
  distribution: readonly ExactDamageDistribution[],
  source: HitResult,
): void {
  const weight = distribution.reduce((total, outcome) => total + outcome.weight, 0);
  const min = distribution[0]?.damage;
  const max = distribution[distribution.length - 1]?.damage;
  const tolerance = Math.max(1e-9, Math.abs(source.nonCritExpected) * 1e-9);
  if (
    !Number.isFinite(weight) ||
    Math.abs(weight - 1) > 1e-9 ||
    min !== source.min ||
    max !== source.max ||
    Math.abs(
      distribution.reduce((total, outcome) => total + outcome.damage * outcome.weight, 0) -
        source.nonCritExpected,
    ) > tolerance
  ) {
    throw new Error("Perfect Equilibrium source distribution diverged from source hit");
  }
}

/**
 * Resolve one ordinary cast hit at its land tick. Time-windowed globals read
 * state at that tick; the cast snapshot carries the next-hit crit layers (first
 * eligible hit only), Chaos Roar's channel rule, empowerment, and Searing Winds
 * cast-time eligibility. Haunted is land-time; SW remains cast-time.

 * Searing Winds and Haunted bonuses are ATTACHED components of this hit - never
 * separate events - so they cannot inflate proc rolls, stacks, or hit counters.
 * Haunted is % of full-accuracy parent post-resolve (cap 20% AD), never re-applied
 * on attached.
 */
export function resolveCastHit(
  rt: SimulationRuntime,
  at: number,
  hitSpec: AbilityHit,
  hitIndex: number,
  ability: AbilitySpec,
  snap: CastSnapshot,
  isDot: boolean,
  convertedChannel = false,
): EventResolution {
  if (isHitReuseActive()) {
    const key = landHitIdentity(rt, at, hitSpec, hitIndex, ability, snap, isDot, convertedChannel);
    const cached = hitReuseGet(key);
    if (cached) {
      recordResolutionCache(true);
      return cached;
    }
    recordResolutionCache(false);
    const resolved = resolveCastHitUncached(
      rt,
      at,
      hitSpec,
      hitIndex,
      ability,
      snap,
      isDot,
      convertedChannel,
    );
    hitReuseSet(key, resolved);
    return resolved;
  }
  return resolveCastHitUncached(rt, at, hitSpec, hitIndex, ability, snap, isDot, convertedChannel);
}

function resolveCastHitUncached(
  rt: SimulationRuntime,
  at: number,
  hitSpec: AbilityHit,
  hitIndex: number,
  ability: AbilitySpec,
  snap: CastSnapshot,
  isDot: boolean,
  convertedChannel: boolean,
  frostbladesActive?: boolean,
  enchantedBoltProcActive?: boolean,
  statefulEnchantedBoltProcActive?: boolean,
): EventResolution {
  const { input, state } = rt;
  const frostMass = activeFrostbladesMass(state.melee.primordialIce, at);
  if (
    frostbladesActive === undefined &&
    frostMass > 0 &&
    frostMass < 1 &&
    ability.style === "melee" &&
    !isDot
  ) {
    const inactive = resolveCastHitUncached(
      rt,
      at,
      hitSpec,
      hitIndex,
      ability,
      snap,
      isDot,
      convertedChannel,
      false,
      enchantedBoltProcActive,
      statefulEnchantedBoltProcActive,
    );
    const active = resolveCastHitUncached(
      rt,
      at,
      hitSpec,
      hitIndex,
      ability,
      snap,
      isDot,
      convertedChannel,
      true,
      enchantedBoltProcActive,
      statefulEnchantedBoltProcActive,
    );
    return mixResolution(inactive, active, frostMass);
  }
  const isCommand = COMMAND_REQUIRES_CONJURE[ability.id] !== undefined;
  const provenance = provenanceForCastHit({
    isCommand,
    isDot,
    convertedChannel,
    dotKind: hitSpec.dotKind,
    bleedId: hitSpec.bleedId,
  });
  if (statefulEnchantedBoltProcActive === undefined) {
    const chance = statefulEnchantedBoltChance(rt, ability, provenance);
    if (chance != null && chance > 0) {
      const inactive = resolveCastHitUncached(
        rt,
        at,
        hitSpec,
        hitIndex,
        ability,
        snap,
        isDot,
        convertedChannel,
        frostbladesActive,
        enchantedBoltProcActive,
        false,
      );
      const active = resolveCastHitUncached(
        rt,
        at,
        hitSpec,
        hitIndex,
        ability,
        snap,
        isDot,
        convertedChannel,
        frostbladesActive,
        enchantedBoltProcActive,
        true,
      );
      const activeState = rt.stochastic.bernoulli(
        enchantedBoltStatefulProcStream(snap.castSeq, hitIndex),
        chance,
      );
      rt.boltProcOutcomes.set(enchantedBoltStatefulProcStream(snap.castSeq, hitIndex), activeState);
      return activeState ? active : inactive;
    }
  }
  if (enchantedBoltProcActive === undefined) {
    const chance = damageOnlyEnchantedBoltChance(rt, ability, provenance);
    if (chance != null && chance > 0) {
      const inactive = resolveCastHitUncached(
        rt,
        at,
        hitSpec,
        hitIndex,
        ability,
        snap,
        isDot,
        convertedChannel,
        frostbladesActive,
        false,
        statefulEnchantedBoltProcActive,
      );
      const active = resolveCastHitUncached(
        rt,
        at,
        hitSpec,
        hitIndex,
        ability,
        snap,
        isDot,
        convertedChannel,
        frostbladesActive,
        true,
        statefulEnchantedBoltProcActive,
      );
      return mixChanceResolution(inactive, active, chance);
    }
  }
  const boltProcActive = enchantedBoltProcActive ?? statefulEnchantedBoltProcActive;
  const modifiers = landTimeModifiers(
    rt,
    at,
    ability,
    snap,
    hitIndex,
    isDot,
    convertedChannel,
    hitSpec.dotKind,
    frostbladesActive,
    provenance,
    boltProcActive,
  );

  const firstEligible = hitIndex === snap.firstEligibleHitIndex;
  const equipmentCrit = dynamicEquipmentCritBonus(
    input.equipmentEffects,
    ability,
    hitIndex,
    activeBleedCount(state.target.melee, at),
  );
  const dracolichCrit =
    ability.style === "ranged"
      ? dracolichInfusionCritChance(state.ranged.dracolichInfusion, at)
      : 0;
  // Concentrated Blast's own hits read the live accumulating stacks; every
  // other magic cast consumed them at cast time (baked into snap.critLayers).
  const liveConcChance =
    ability.style === "magic" && isConcentratedBlast(ability.id)
      ? (state.magic.concCritStacks * state.magic.concCritPerStackPct) / 100
      : 0;
  const rawCrit: CritLayers = {
    ...snap.critLayers,
    eligible: hitSpec.critEligible ?? true,
    chance:
      snap.critLayers.chance +
      liveConcChance +
      (ability.style === "magic" &&
      state.magic.sunshine.grantedByCast !== snap.castSeq &&
      sunshineActive(state.magic.sunshine, at)
        ? (input.equipmentEffects?.setCritChance?.conditional.sunshine ?? 0)
        : 0) +
      (firstEligible && snap.furyActive ? FURY_CRIT_CHANCE_BONUS : 0) +
      equipmentCrit.chance +
      dracolichCrit,
    guaranteed: snap.critLayers.guaranteed || (firstEligible && snap.greaterFuryActive),
    damageBonus:
      (snap.critLayers.damageBonus ?? 0) +
      (ability.style === "magic" ? channelledMightCritBonus(state.magic.channelledMight, at) : 0) +
      equipmentCrit.damageBonus,
  };
  const crit = resolveLeagueCritAtLand(input.league, rawCrit);

  // Command abilities are part of the conjure: full Damage Potential, the
  // conjure-eligible modifier set (never prayers), and for the skeleton the
  // live rage multiplier at the land tick (wiki, verified 2026-07-31).
  let band = hitSpec.band;
  if (ability.id === "command_skeleton_warrior") {
    const spirit = findConjure(state.necromancy.conjures, "skeleton_warrior");
    const mult = skeletonRageMult(spirit?.rageStacks ?? 0);
    if (mult !== 1) band = { minPct: band.minPct * mult, maxPct: band.maxPct * mult };
  }
  const targetVitality = state.target.vitality;
  const targetHealthFraction =
    targetVitality && targetVitality.maximumLifePoints > 0
      ? targetVitality.currentLifePoints / targetVitality.maximumLifePoints
      : null;
  const ammunition = resolveRangedAmmunitionHitEffects({
    ammunition: input.ammunition,
    style: ability.style,
    provenance,
    attackOrigin: "player",
    attackKind: "ability",
    targetClassification: input.targetClassification,
    targetHealthFraction,
    enchantedBoltProcActive: boltProcActive,
  });
  if (ammunition.abilityDamageFraction !== 0) {
    const addition = ammunition.abilityDamageFraction * 100;
    band = { minPct: band.minPct + addition, maxPct: band.maxPct + addition };
  }
  if (ammunition.maximumHitBandFraction > 0) {
    band = {
      minPct: band.minPct,
      maxPct: band.maxPct + ammunition.maximumHitBandFraction * 100,
    };
  }
  const targetDamagePotentialBeforeAmmunition = input.targetAccuracyProfile
    ? resolveLiveTargetDamagePotential(input.targetAccuracyProfile, {
        ...(state.target.blackStone
          ? {
              blackStone: {
                state: state.target.blackStone,
                currentTick: at,
              },
            }
          : {}),
        equipmentEffects: input.equipmentEffects,
      })
    : input.accuracy;
  const wenDamagePotentialDelta = snap.wenIcyPrecisionDamagePotentialAtCast
    ? WEN_ICY_PRECISION_DAMAGE_POTENTIAL_DELTA
    : 0;
  // Reaper applies +0.1 percentage point hit chance per active successful
  // personal hit. It is neither a damage multiplier nor an on-hit proc.
  const reaperDamagePotentialDelta =
    isEofEquipped(input) && isEofReaperHitEligible(provenance)
      ? eofReaperBonus(state.accessories.reaper, at)
      : 0;
  const effectiveAccuracy =
    ammunition.damagePotentialDelta === 0 &&
    wenDamagePotentialDelta === 0 &&
    reaperDamagePotentialDelta === 0
      ? targetDamagePotentialBeforeAmmunition
      : Math.max(
          0,
          Math.min(
            1,
            targetDamagePotentialBeforeAmmunition +
              ammunition.damagePotentialDelta +
              wenDamagePotentialDelta +
              reaperDamagePotentialDelta,
          ),
        );
  const accuracyWithBoltOverride = ammunition.accuracyOverride ?? effectiveAccuracy;
  // Wiki hit chance: commands and Sunshine / Greater Sunshine zone DoT bypass DP.
  // https://runescape.wiki/w/Hit_chance
  const hitAccuracy =
    isCommand || ability.id === "sunshine" || ability.id === "greater_sunshine"
      ? 1
      : accuracyWithBoltOverride;
  const damageSource = outgoingSourceOf(provenance);
  const hitContext: import("../../types").CombatContext = {
    ...input.context,
    style: ability.style,
    dotKind: hitSpec.dotKind,
    abilityCategory: ability.category,
    basicAttack: isBasicAttack(ability),
    area: ability.area,
    damageSource,
    provenance,
  };
  const level = combatLevelAt(rt, at);
  const base = combatBaseAt(rt, at, level);
  const essenceFlat = essenceCorruptionFlatBonus(
    input.equipmentEffects?.songOfDestruction ?? NO_SONG_OF_DESTRUCTION,
    state.magic.song.essenceCorruption,
    at,
    level,
    ability,
    provenance,
  );
  const ashenVowActive =
    snap.ashenVowAtCast &&
    ability.style === "melee" &&
    !isDot &&
    provenance.kind === "player_direct" &&
    state.target.melee.flameboundRival;
  const attachedTermBase = ashenVowActive
    ? applyAbilityBaseModifiers(
        base,
        modifiers.filter((modifier) => modifier.id !== "passive:ashen-vow"),
        hitContext,
      ).base
    : undefined;
  // Tuska on-task: flat 100x Slayer (15k cap); keep only Havoc's global final multiplier.
  // https://runescape.wiki/w/Tuska%27s_Wrath
  const tuskaFinalModifiers = modifiers.filter(
    (modifier) => modifier.id === "blessing:havoc-born" && modifier.stage === "postHit",
  );
  const bashPrepared = snap.bashDamage
    ? applyAbilityBaseModifiers(base, modifiers, hitContext)
    : null;
  const bashBand = bashPrepared ? bashRawDamageBand(bashPrepared.base, snap.bashDamage!) : null;
  if (bashBand && (input.preciseRank ?? 0) > 0) {
    bashBand.min = Math.min(
      bashBand.max,
      Math.floor(bashBand.min + preciseMinHitAddition(bashBand.max, input.preciseRank!)),
    );
  }
  const host =
    snap.tuskasEmpoweredDamage != null
      ? resolveLeagueAttachedRawHost({
          rules: input.league,
          source: provenance,
          landTick: at,
          abilityBase: base,
          min: snap.tuskasEmpoweredDamage,
          max: snap.tuskasEmpoweredDamage,
          level,
          accuracy: 1,
          crit: { chance: 0, eligible: false },
          modifiers: tuskaFinalModifiers,
          context: hitContext,
          cap: { cap: TUSKAS_EMPOWERED_HIT_CAP },
        })
      : bashBand && bashPrepared
        ? resolveLeagueAttachedRawHost({
            rules: input.league,
            source: provenance,
            landTick: at,
            abilityBase: bashPrepared.base,
            min: bashBand.min,
            max: bashBand.max,
            level,
            accuracy: hitAccuracy,
            crit,
            modifiers: bashPrepared.modifiers,
            context: hitContext,
            cap: input.cap,
          })
        : resolveLeagueAttachedHost({
            rules: input.league,
            source: provenance,
            landTick: at,
            base,
            band,
            level,
            accuracy: hitAccuracy,
            crit,
            ...(snap.surgingStormAtCast
              ? { critDamageDistribution: SURGING_STORM_CRIT_DAMAGE_DISTRIBUTION }
              : {}),
            modifiers: isCommand ? conjureEligibleModifiers(modifiers) : modifiers,
            context: hitContext,
            cap: input.cap,
            preciseRank: input.preciseRank,
            ...(attachedTermBase !== undefined ? { attachedTermBase } : {}),
            ...(essenceFlat > 0 ? { postDamagePotentialFlat: essenceFlat } : {}),
          });
  const hit = host.baseHit;

  // Choir free DS uses the same mass as ammo dragonstone; build whenever either may need it.
  const choirNeedsSourceDistribution =
    chromaticChoirActive(input.equipmentEffects?.chromaticChoir) &&
    (input.equipmentEffects?.chromaticChoir?.gems.includes("dragonstone") ?? false);
  const ammunitionSourceDistribution =
    (ammunition.mechanicId === "dragonstone" || choirNeedsSourceDistribution) &&
    !isDot &&
    isAmmunitionHitEligible({
      style: ability.style,
      provenance,
      attackOrigin: "player",
    })
      ? ammunitionSourceDamageDistribution({
          base,
          band,
          level,
          accuracy: hitAccuracy,
          crit,
          ...(snap.surgingStormAtCast
            ? { critDamageDistribution: SURGING_STORM_CRIT_DAMAGE_DISTRIBUTION }
            : {}),
          modifiers: isCommand ? conjureEligibleModifiers(modifiers) : modifiers,
          context: hitContext,
          cap: input.cap,
          preciseRank: input.preciseRank,
          ...(essenceFlat > 0 ? { postDamagePotentialFlat: essenceFlat } : {}),
        })
      : undefined;

  const ammunitionOriginalDamagePotential =
    boltProcActive === true && ammunition.mechanicId === "onyx"
      ? resolveLeagueAttachedHost({
          rules: input.league,
          source: provenance,
          landTick: at,
          base,
          band,
          level,
          accuracy: hitAccuracy,
          crit,
          ...(snap.surgingStormAtCast
            ? { critDamageDistribution: SURGING_STORM_CRIT_DAMAGE_DISTRIBUTION }
            : {}),
          modifiers: isCommand
            ? conjureEligibleModifiers(
                landTimeModifiers(
                  rt,
                  at,
                  ability,
                  snap,
                  hitIndex,
                  isDot,
                  convertedChannel,
                  hitSpec.dotKind,
                  frostbladesActive,
                  provenance,
                  false,
                ),
              )
            : landTimeModifiers(
                rt,
                at,
                ability,
                snap,
                hitIndex,
                isDot,
                convertedChannel,
                hitSpec.dotKind,
                frostbladesActive,
                provenance,
                false,
              ),
          context: hitContext,
          cap: input.cap,
          preciseRank: input.preciseRank,
          ...(essenceFlat > 0 ? { postDamagePotentialFlat: essenceFlat } : {}),
        }).baseHit.expected
      : undefined;

  const sourcePrecritDistribution = sourceDistributionForPerfectEquilibrium({
    ability,
    snap,
    isDot,
    convertedChannel,
    provenance,
  })
    ? calculateNonCriticalHitDistribution({
        base,
        band,
        level,
        accuracy: hitAccuracy,
        crit: { ...crit, chance: 0, guaranteed: false, eligible: false },
        modifiers: isCommand ? conjureEligibleModifiers(modifiers) : modifiers,
        context: hitContext,
        provenance,
        cap: input.cap,
        preciseRank: input.preciseRank,
        ...(essenceFlat > 0 ? { postDamagePotentialFlat: essenceFlat } : {}),
      })
    : undefined;
  if (sourcePrecritDistribution) {
    validatePerfectEquilibriumSourceDistribution(sourcePrecritDistribution, hit);
  }

  const components: AttachedDamageComponent[] = host.components.map((component) =>
    attachedResolutionComponent(component),
  );
  if (snap.searingWindsAtCast) {
    // Attached kind: canTriggerProcs false. On-hit gear only when parent is direct-hit
    // family (Corruption Shot DoT ticks must not gain Slayer/Salve via SW).
    const attachedProv = { kind: "attached" as const, detail: "searing_winds" };
    const bonusProv = capabilitiesOf(provenance).onHitGear ? attachedProv : provenance;
    const bonus = calculateHit({
      base,
      band: { minPct: SEARING_WINDS_BONUS_HIT_PCT, maxPct: SEARING_WINDS_BONUS_HIT_PCT },
      level,
      accuracy: targetDamagePotentialBeforeAmmunition,
      crit: { chance: 0, eligible: false },
      modifiers,
      provenance: bonusProv,
      context: {
        ...hitContext,
        damageSource,
        provenance: bonusProv,
      },
      cap: input.cap,
    });
    components.push({
      id: "searing_winds",
      damage: {
        min: bonus.min,
        max: bonus.max,
        expected: bonus.expected,
        critExpected: bonus.critExpected,
        capLoss: bonus.capLoss,
        critical: packageCritical(bonus.critChance, bonus.critExpected, bonus.nonCritExpected),
      },
      hitDetail: bonus,
      attached: true,
      hitCapPolicy: "separate",
    });
  }
  // Haunted: land-time; 10% of full-accuracy parent, cap 20% of live cap AD.
  // Only the parent hit - never re-apply on attached components (SW / Haunted itself).
  const haunted = state.target.haunted;
  if (hauntedActive(haunted, at)) {
    const capAD = haunted.capAbilityDamage;
    const pot = hit.potential;
    const bonusMin = hauntedBonusDamage(hauntedParentDamage(hit.min, pot), capAD);
    const bonusMax = hauntedBonusDamage(hauntedParentDamage(hit.max, pot), capAD);
    const bonusExpected = hauntedBonusDamage(hauntedParentDamage(hit.expected, pot), capAD);
    if (bonusMax > 0 || bonusExpected > 0) {
      components.push({
        id: "haunted",
        damage: {
          min: bonusMin,
          max: bonusMax,
          expected: bonusExpected,
        },
        attached: true,
        hitCapPolicy: "separate",
      });
    }
  }

  // Attuned crystal weaponry: EV bonus on direct player hits only.
  // Source is pure host damage; attached riders and this bonus cannot re-proc it.
  const attunedCrystal = input.equipmentEffects?.attunedCrystalWeaponry;
  if (
    attunedCrystal &&
    isAttunedCrystalWeaponryHitEligible(provenance) &&
    attunedCrystal.procChance > 0
  ) {
    const bonusExpected = attunedCrystalExpectedBonus(host.hit.expected, attunedCrystal.procChance);
    if (bonusExpected > 0) {
      components.push({
        id: ATTUNED_CRYSTAL_COMPONENT_ID,
        damage: {
          min: 0,
          max: 0,
          expected: bonusExpected,
        },
        attached: true,
        hitCapPolicy: "separate",
        analysis: {
          kind: "equipment-passive",
          expectedActivations: attunedCrystal.procChance,
        },
      });
    }
  }

  let min = host.hit.min;
  let max = host.hit.max;
  let expected = host.hit.expected;
  let capLoss = host.hit.capLoss;
  let critExpected = host.hit.critExpected;
  for (const c of components) {
    if (c.hitCapPolicy === "shared") continue;
    min += c.damage.min;
    max += c.damage.max;
    expected += c.damage.expected;
    capLoss += c.damage.capLoss ?? 0;
    critExpected += c.damage.expected;
  }

  return {
    damage: {
      min,
      max,
      expected,
      critExpected,
      capLoss,
      critical: packageCritical(
        host.hit.critChance,
        host.hit.critExpected,
        host.hit.nonCritExpected,
      ),
    },
    hitDetail: hit,
    ...(ammunitionSourceDistribution ? { ammunitionSourceDistribution } : {}),
    ...(ammunitionOriginalDamagePotential !== undefined
      ? { ammunitionOriginalDamagePotential }
      : {}),
    ...(components.length > 0 ? { components } : {}),
    ...(sourcePrecritDistribution ? { sourcePrecritDistribution } : {}),
  };
}
