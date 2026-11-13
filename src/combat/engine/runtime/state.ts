import type { AbilitySpec } from "../../pipeline/calculateAbility";
import { gainBloodlust } from "../../styles/melee/bloodlust";
import {
  newMeleeRotationState,
  newMeleeTargetEffects,
  type MeleeRotationState,
  type MeleeTargetEffects,
} from "../../styles/melee/effects";
import { newMagicRotationState, type MagicRotationState } from "../../styles/magic/effects";
import { newBurns, type BurnState } from "../../styles/magic/burn";
import { newRangedRotationState, type RangedRotationState } from "../../styles/ranged/effects";
import {
  newNecromancyRotationState,
  type NecroRotationState,
  type NecromancyRotationState,
} from "../../styles/necromancy/effects";
import type { ConjureState } from "../../styles/necromancy/conjures";
import { newHaunted, type HauntedState } from "../../styles/necromancy/haunted";
import { NO_LEVEL_OVERRIDE, type EffectiveLevelOverride } from "../../core/effectiveLevel";
import type { PlayerVitality } from "../../core/playerVitality";
import { NO_DEATH_PREVENTION, type DeathPreventionState } from "./deathPrevention";
import { newNaragiRuntime, type NaragiRuntimeState } from "../../league/naragiEdict";
import { firstChargeReadyTick, maxChargesFor } from "./charges";
import type { PoisonTier } from "../../poison/mechanics";
import type { TimedTargetStatus } from "../../target/timedStatus";
import type { BlackStoneArmourState } from "../../styles/ranged/blackStone";
import { newEofReaperState, type EofReaperState } from "../../shared/eofPassives";
import { inactiveRevengeState, type RevengeState } from "../../styles/shared/revenge";
import {
  newScriptureOfAmascutState,
  type ScriptureOfAmascutState,
} from "../../passives/scriptureOfAmascut";

export type { MeleeRotationState, RangedRotationState, MagicRotationState };
export type { NecroRotationState, NecromancyRotationState, ConjureState };
export {
  clearCharges,
  consumeCharge,
  firstChargeReadyTick,
  maxChargesFor,
  pruneCharges,
  readyChargeCount,
} from "./charges";
export const ADRENALINE_CAP = 100;

/** Ability id -> first tick it can be cast again. Absent = no individual cooldown. */
export type CooldownState = Readonly<Record<string, number>>;

/**
 * Ability key -> sorted ready-at ticks of recovering charges.
 * Key = cooldownGroup ?? replacementGroup ?? id (same as CD key).
 * Length = recovering slots. Empty / absent = all ready.
 */
export type ChargeState = Readonly<Record<string, readonly number[]>>;

export interface LeagueRotationState {
  avernicRampageUntilTick: number;
  strikingLightReadyTick: number;
  lordOfLightReadyTick: number;
  tearingThornsHitCount?: number;
}

/**
 * Player-side sim state (LP, death-prevention, temporary level override, Naragi).
 * Optional: absent on pure outgoing rotations that never touch player HP.
 */
export interface PlayerRuntimeState {
  vitality: PlayerVitality;
  /** True after an unprevented lethal hit. */
  dead: boolean;
  levelOverride: EffectiveLevelOverride;
  deathPrevention: DeathPreventionState;
  naragi: NaragiRuntimeState;
  /** Cumulative effective self-heal from Naragi pulses this run. */
  naragiHealed: number;
  /** Cumulative overheal from Naragi pulses this run. */
  naragiOverheal: number;
}

export function newPlayerRuntimeState(
  opts: { maximumLifePoints?: number; currentLifePoints?: number } = {},
): PlayerRuntimeState {
  const max = Math.max(0, opts.maximumLifePoints ?? 0);
  const cur =
    opts.currentLifePoints != null && Number.isFinite(opts.currentLifePoints)
      ? Math.max(0, opts.currentLifePoints)
      : max;
  return {
    vitality: { maximumLifePoints: max, currentLifePoints: cur },
    dead: false,
    levelOverride: NO_LEVEL_OVERRIDE,
    deathPrevention: NO_DEATH_PREVENTION,
    naragi: newNaragiRuntime(),
    naragiHealed: 0,
    naragiOverheal: 0,
  };
}

/** Dynamic effects the simulation has put on the target, not on the player. */
export interface TargetRuntimeState {
  /** Tick of the latest damaging cast against this target; -1 before combat. */
  lastAttackTick: number;
  /** Burn debuffs applied to the target (Combust). */
  burns: BurnState;
  /**
   * Cast sequence of the active Bloated debuff (-1 = none). Recasting Bloat
   * overwrites the previous debuff: its pending tails are cancelled by owner
   * (wiki: the duration resets on recast).
   */
  bloatedByCast: number;
  melee: MeleeTargetEffects;
  /** Haunted debuff from Command Vengeful Ghost autos. */
  haunted: HauntedState;
  weaponPoison: TargetWeaponPoisonSample;
  evolvingToxin: EvolvingToxinState;
  vitality?: TargetVitalityState;
  deathMark?: TimedTargetStatus;
  blackStone?: BlackStoneArmourState;
}

export interface TargetVitalityState {
  readonly maximumLifePoints: number;
  readonly currentLifePoints: number;
}

export interface TargetWeaponPoisonSample {
  readonly poison: TargetWeaponPoisonState;
  readonly immunityDisabledUntilTick: number;
}

export interface TargetWeaponPoisonState {
  readonly active: boolean;
  readonly expiresAtTick: number;
  readonly effectiveTier: PoisonTier;
  readonly decayIndex: number;
  readonly remainingHits: number;
  readonly cadenceTicks: 8 | 16;
  readonly nextHitTick: number;
  readonly pendingEventSeq: number;
  readonly sourceDamageMultiplier: number;
  readonly cinderbaneContinuation: boolean;
  readonly sourceLabel: string;
  readonly pendingApplicationHits: readonly TargetWeaponPoisonPendingHit[];
}

export type TargetWeaponPoisonHitMultiplicity =
  | { readonly kind: "single" }
  | {
      readonly kind: "positive-binomial";
      readonly trials: number;
      readonly probability: number;
    }
  | {
      readonly kind: "positive-geometric";
      readonly continuationProbability: number;
    };

export interface TargetWeaponPoisonPendingHit {
  readonly tick: number;
  readonly seq: number;
  readonly multiplicity: TargetWeaponPoisonHitMultiplicity;
}

export interface EvolvingToxinState {
  stacks: number;
  expiresAtTick: number;
}

export function inactiveTargetWeaponPoisonState(): TargetWeaponPoisonState {
  return {
    active: false,
    expiresAtTick: 0,
    effectiveTier: 1,
    decayIndex: 0,
    remainingHits: 0,
    cadenceTicks: 16,
    nextHitTick: 0,
    pendingEventSeq: -1,
    sourceDamageMultiplier: 1,
    cinderbaneContinuation: false,
    sourceLabel: "",
    pendingApplicationHits: [],
  };
}

export function inactiveTargetWeaponPoison(): TargetWeaponPoisonSample {
  return {
    poison: inactiveTargetWeaponPoisonState(),
    immunityDisabledUntilTick: 0,
  };
}

export function inactiveEvolvingToxin(): EvolvingToxinState {
  return { stacks: 0, expiresAtTick: 0 };
}

/**
 * The complete simulation state. Everything mutable lives here - never in
 * module globals or captured closure state - and every field is replaced rather
 * than mutated in place, so runtime snapshots remain isolated.

 * Genuinely global clocks stay at the top level; everything else belongs to the
 * style that owns its mechanics, or to the target it was applied to.
 */
export interface RotationState {
  /** Next tick free for a cast - the global cooldown is encoded here. */
  tick: number;
  adrenaline: number;
  adrenalineCap: number;
  /**
   * Loadout-static Ring of Vigour (equipment OR permanent passive). Used by cost/spend
   * for weapon specials; never mutated mid-sim.
   */
  ringOfVigour: boolean;
  /** Vestments set(2): exclusive end of the 15%-over-18s regeneration. */
  vestmentsAdrenalineUntilTick: number;
  cooldowns: CooldownState;
  /**
   * Independent charge recovery clocks. Charged abilities do not write
   * cooldowns[key] for their own cast.
   */
  charges: ChargeState;
  /**
   * Relentless perk lockout: after a proc the perk cannot activate again until
   * this tick (wiki: 30s internal cooldown; 0 = ready). Style-agnostic.
   */
  relentlessUntilTick: number;
  /** Equipment-state effects; absent from old source model snapshots only. */
  accessories: {
    reaper: EofReaperState;
  };
  invention: {
    /** Crackling starts ready and triggers on the next eligible attack. */
    cracklingReadyTick: number;
    /** Expected damage accumulated toward the 50,000 Aftershock threshold. */
    aftershockCharge: number;
    /** Earliest tick another Aftershock blast may land. */
    aftershockReadyTick: number;
    /** A threshold-crossing blast is already queued, possibly behind its cooldown. */
    aftershockPending: boolean;
  };
  naturalInstinctUntilTick: number;
  scriptureOfAmascut: ScriptureOfAmascutState;
  defence: {
    revenge: RevengeState;
  };
  league?: LeagueRotationState;
  /** Player LP / revive / level-override / Naragi runtime (optional). */
  player?: PlayerRuntimeState;
  melee: MeleeRotationState;
  ranged: RangedRotationState;
  magic: MagicRotationState;
  necromancy: NecromancyRotationState;
  target: TargetRuntimeState;
}

export function newRotationState(
  opts: {
    lantern?: boolean;
    adrenaline?: number;
    adrenalineCap?: number;
    naturalInstinctUntilTick?: number;
    league?: boolean;
    ringOfVigour?: boolean;
    player?: boolean | { maximumLifePoints?: number; currentLifePoints?: number };
  } = {},
): RotationState {
  const adrenalineCap = opts.adrenalineCap ?? ADRENALINE_CAP;
  const playerOpts =
    opts.player === true
      ? {}
      : typeof opts.player === "object" && opts.player != null
        ? opts.player
        : null;
  return {
    tick: 0,
    adrenaline: Math.min(adrenalineCap, opts.adrenaline ?? 0),
    adrenalineCap,
    ringOfVigour: opts.ringOfVigour === true,
    vestmentsAdrenalineUntilTick: 0,
    cooldowns: {},
    charges: {},
    relentlessUntilTick: 0,
    accessories: {
      reaper: newEofReaperState(),
    },
    invention: {
      cracklingReadyTick: 0,
      aftershockCharge: 0,
      aftershockReadyTick: 0,
      aftershockPending: false,
    },
    naturalInstinctUntilTick: opts.naturalInstinctUntilTick ?? 0,
    scriptureOfAmascut: newScriptureOfAmascutState(),
    defence: { revenge: inactiveRevengeState() },
    ...(opts.league
      ? {
          league: {
            avernicRampageUntilTick: 0,
            strikingLightReadyTick: 0,
            lordOfLightReadyTick: 0,
            tearingThornsHitCount: 0,
          },
        }
      : {}),
    ...(playerOpts != null ? { player: newPlayerRuntimeState(playerOpts) } : {}),
    melee: newMeleeRotationState(),
    ranged: newRangedRotationState(),
    magic: newMagicRotationState(),
    necromancy: newNecromancyRotationState({ lantern: opts.lantern }),
    target: {
      lastAttackTick: -1,
      burns: newBurns(),
      bloatedByCast: -1,
      melee: newMeleeTargetEffects(),
      haunted: newHaunted(),
      weaponPoison: inactiveTargetWeaponPoison(),
      evolvingToxin: inactiveEvolvingToxin(),
    },
  };
}

export function patchPlayer(
  state: RotationState,
  patch: Partial<PlayerRuntimeState>,
): RotationState {
  const base = state.player ?? newPlayerRuntimeState();
  return { ...state, player: { ...base, ...patch } };
}

export function patchDefence(
  state: RotationState,
  patch: Partial<RotationState["defence"]>,
): RotationState {
  return { ...state, defence: { ...state.defence, ...patch } };
}

export function patchScriptureOfAmascut(
  state: RotationState,
  scriptureOfAmascut: ScriptureOfAmascutState,
): RotationState {
  return { ...state, scriptureOfAmascut };
}

export function gainAdrenaline(state: RotationState, amount: number): RotationState {
  return { ...state, adrenaline: Math.min(state.adrenalineCap, state.adrenaline + amount) };
}

export function spendAdrenaline(state: RotationState, amount: number): RotationState {
  return { ...state, adrenaline: Math.max(0, state.adrenaline - amount) };
}

/**
 * GCD-free tick and any per-ability cooldown / charge readiness combined.
 * When maxCharges > 0, charge clocks gate the key (cooldownGroup ?? abilityId)
 * instead of treating a missing cooldowns[key] as fully free after one cast.
 */
export function firstLegalTick(
  state: RotationState,
  abilityId: string,
  cooldownGroup?: string,
  opts?: { maxCharges?: number },
): number {
  const ordinary = Math.max(
    state.tick,
    state.cooldowns[abilityId] ?? 0,
    cooldownGroup ? (state.cooldowns[cooldownGroup] ?? 0) : 0,
  );
  const max = opts?.maxCharges;
  if (max == null || max <= 0) return ordinary;
  const key = cooldownGroup ?? abilityId;
  return Math.max(ordinary, firstChargeReadyTick(state, key, max, state.tick));
}

/** Ability-aware readiness using charges from the spec at player level. */
export function firstLegalTickFor(
  state: RotationState,
  ability: AbilitySpec,
  level: number,
): number {
  const max = maxChargesFor(ability, level);
  return firstLegalTick(
    state,
    ability.id,
    ability.cooldownGroup ?? ability.replacementGroup,
    max > 0 ? { maxCharges: max } : undefined,
  );
}

export function startCooldown(
  state: RotationState,
  abilityId: string,
  ticks: number,
): RotationState {
  return { ...state, cooldowns: { ...state.cooldowns, [abilityId]: state.tick + ticks } };
}

export function clearCooldowns(state: RotationState, ids: readonly string[]): RotationState {
  if (ids.length === 0) return state;
  const cooldowns = { ...state.cooldowns };
  for (const id of ids) delete cooldowns[id];
  return { ...state, cooldowns };
}

export function patchMelee(
  state: RotationState,
  patch: Partial<MeleeRotationState>,
): RotationState {
  return { ...state, melee: { ...state.melee, ...patch } };
}

export function patchRanged(
  state: RotationState,
  patch: Partial<RangedRotationState>,
): RotationState {
  return { ...state, ranged: { ...state.ranged, ...patch } };
}

export function patchMagic(
  state: RotationState,
  patch: Partial<MagicRotationState>,
): RotationState {
  return { ...state, magic: { ...state.magic, ...patch } };
}

/** Necro resource fields only - prefer applyNecroOnCast for cast transitions. */
export function patchNecro(
  state: RotationState,
  patch: Partial<NecroRotationState>,
): RotationState {
  return {
    ...state,
    necromancy: { ...state.necromancy, resources: { ...state.necromancy.resources, ...patch } },
  };
}

export function patchConjures(state: RotationState, conjures: ConjureState): RotationState {
  return { ...state, necromancy: { ...state.necromancy, conjures } };
}

export function patchTarget(
  state: RotationState,
  patch: Partial<TargetRuntimeState>,
): RotationState {
  return { ...state, target: { ...state.target, ...patch } };
}

export function patchLeague(
  state: RotationState,
  patch: Partial<LeagueRotationState>,
): RotationState {
  if (!state.league) return state;
  return { ...state, league: { ...state.league, ...patch } };
}

export function gainMeleeBloodlust(state: RotationState, base: number): RotationState {
  return patchMelee(state, { bloodlust: gainBloodlust(state.melee.bloodlust, base) });
}
