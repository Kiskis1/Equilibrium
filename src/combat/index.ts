/**
 * Deliberate public combat API for UI / app consumers.
 * Prefer deep imports for solver, style catalogues, and engine internals.
 * Architecture allowlist: scripts/architecture/public-api.mjs
 */

export * from "./core/damagePerLevel";
export * from "./core/ticks";
export * from "./core/rounding";
export * from "./core/damagePotential";
export * from "./core/hitCaps";
export * from "./core/critical";
export * from "./core/defence";
export * from "./core/lifePoints";
export * from "./core/realizedLifePoints";
export * from "./core/playerVitality";
export * from "./core/effectiveLevel";
export * from "./core/abilityDamage";

export * from "./pipeline/modifierPipeline";
export * from "./pipeline/calculateHit";
export * from "./pipeline/calculateAbility";
export * from "./target/genericTarget";
export * from "./types";

export * from "./shared/perks";
export * from "./shared/equipment";
export * from "./shared/equipmentStats";
export * from "./shared/attunedCrystalWeaponry";
export {
  equipmentRecordPassiveIds,
  meetsPassiveRequirement,
  missingPassiveMessage,
  passiveIdsFromEquipmentIds,
  permanentAvailabilityBlock,
  resolveAbilityCastAvailability,
  resolveLeagueAbilityAvailability,
  type AbilityAvailabilityOptions,
  type AbilityCastAvailability,
  type LeagueAbilityAvailability,
} from "./shared/abilityAvailability";
export * from "./shared/prayers";
export * from "./shared/vulnerability";
export * from "./shared/berserkersFury";
export * from "./shared/furyOfTheSmall";
export * from "./shared/adrenalineGain";
export * from "./shared/adrenalineTransaction";
export * from "./shared/adrenalineCap";
export * from "./shared/heightenedSenses";
export * from "./shared/conservationOfEnergy";
export * from "./shared/ringOfVigour";
export * from "./shared/slayerHelmet";
export * from "./shared/salveAmulet";
export * from "./shared/onHitEligibility";
export * from "./shared/archaeologyRelics";
export * from "./shared/potions";
export * from "./styles/magic/ancientSpells";

export type {
  DamageEffectBreakdown,
  DamageEffectGroupBreakdown,
  DamageSourceKind,
  PlayerPoisonAnalysis,
  PlayerPoisonTargetState,
  RotationSummary,
  CastRecord,
  SimulateInput,
  CastContext,
} from "./engine/simulation/contracts";
export type { ResolvedEvent } from "./engine/runtime/events";
export { rotationOf } from "./engine/simulation/contracts";
export { simulate } from "./engine/simulation/simulate";
export { createSteppedCastContext, type SteppedCastContext, type SteppedCastResult } from "./engine/simulation/steppedContext";
export { drainHostEvents, scheduleHostEvent, nextHostTick, type HostQueuedEvent } from "./engine/encounter/hostClock";
export { seededXorshift32, type SerializableRandomStream } from "./engine/encounter/randomStream";
export { planHostedCast, type HostedCastInput, type HostedCastPlan, type HostedCastSpec } from "./engine/encounter/hostCast";
export { simulateRevolution } from "./engine/simulation/revolution";

export * from "./league/ruleset";
export * from "./league/icyenicFaith";
export * from "./league/naragiEdict";
export * from "./league/relicGrantedItems";
export * from "./league/naragiActivation";
export * from "./league/damage";

export {
  ABILITY_REGISTRY,
  engineSpecs,
  allEngineSpecs,
  engineSpecsForStyle,
  entryByEngineId,
  entryByRecordId,
  solverPalette,
  engineIdForRecord,
  type AbilityRegistryEntry,
} from "./abilities/registry";

export * from "./data/sources";
export * from "./data/availability";

export {
  solve,
  solveFromRequest,
  packSolverRequest,
  evaluateRevolutionBar,
  buildCandidatePool,
  OBJECTIVE_HORIZON_TICKS,
  OBJECTIVE_PRESETS,
  TIER_BUDGETS,
  runOptimize,
  cancelOptimize,
} from "./solver";
