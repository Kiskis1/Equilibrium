/**
 * Essence of Finality passive rules. Keep hit chance, Soul Split heal and
 * protection-prayer mitigation as distinct effects.
 *
 * https://runescape.wiki/w/Essence_of_Finality_amulet
 * https://runescape.wiki/w/Soul_Split
 *
 * All functions are pure: the actual cast/land host supplies the outcome
 * of RNG before invoking them. No expected/mean result is substituted for
 * a realized integer heal or HP change.
 */
import { secondsToTicks } from "../core/ticks";
import type { DamageProvenance } from "./damageProvenance";

export const EOF_EQUIPMENT_IDS = [
  "item:essence-of-finality",
  "item:essence-of-finality-or",
] as const;
export const EOF_SOUL_SPLIT_PROC_CHANCE = 0.5;
export const EOF_SOUL_SPLIT_BONUS_MIN = 0.25;
export const EOF_SOUL_SPLIT_BONUS_MAX = 0.5;
export const EOF_REAPER_MAX_STACKS = 30;
export const EOF_REAPER_HIT_CHANCE_PER_STACK = 0.001;
export const EOF_REAPER_DURATION_TICKS = secondsToTicks(54);

export type EofEquipmentInput = {
  readonly equipmentIds?: readonly string[];
  readonly equipmentSlots?: Readonly<Partial<Record<string, string | null>>>;
};

export function isEofEquipped(input: EofEquipmentInput): boolean {
  const items: readonly string[] = EOF_EQUIPMENT_IDS;
  if (Object.hasOwn(input.equipmentSlots ?? {}, "amulet")) {
    return items.includes(input.equipmentSlots?.amulet ?? "");
  }
  return input.equipmentIds?.some(id => items.includes(id)) === true;
}

export interface EofReaperState {
  readonly stacks: number;
  /** Exclusive expiry tick. On the next successful eligible hit it refreshes. */
  readonly expiresTick: number;
}

export const newEofReaperState = (): EofReaperState => ({ stacks: 0, expiresTick: 0 });

export function isEofReaperHitEligible(provenance: DamageProvenance): boolean {
  switch (provenance.kind) {
    case "player_direct":
    case "player_auto":
    case "player_dot":
    case "player_converted_channel":
    case "derived_bounce":
    case "derived_tail":
      return true;
    default:
      return false;
  }
}

function validateReaper(state: EofReaperState, tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0 ||
      !Number.isInteger(state.stacks) || state.stacks < 0 ||
      state.stacks > EOF_REAPER_MAX_STACKS ||
      !Number.isSafeInteger(state.expiresTick) || state.expiresTick < 0) {
    throw new RangeError("Invalid EOF Reaper state or tick");
  }
}

export function eofReaperBonus(state: EofReaperState, tick: number): number {
  validateReaper(state, tick);
  return tick < state.expiresTick
    ? state.stacks * EOF_REAPER_HIT_CHANCE_PER_STACK
    : 0;
}

/** Called after each valid landed personal hit, not at cast/legality preview. */
export function advanceEofReaper(args: {
  readonly state: EofReaperState;
  readonly tick: number;
  readonly equipped: boolean;
  readonly eligible: boolean;
  readonly landed: boolean;
}): EofReaperState {
  const { state, tick, equipped, eligible, landed } = args;
  validateReaper(state, tick);
  if (!equipped) return newEofReaperState();
  if (!eligible || !landed) return state;
  return {
    stacks: Math.min(
      EOF_REAPER_MAX_STACKS,
      (tick < state.expiresTick ? state.stacks : 0) + 1,
    ),
    expiresTick: tick + EOF_REAPER_DURATION_TICKS,
  };
}

/** Exact integer heal/converted-hit modifier; RNG is sampled by the host. */
export function resolveEofSoulSplit(args: {
  readonly nominal: number;
  readonly equipped: boolean;
  readonly activated: boolean;
  readonly bonusFraction?: number;
}): number {
  const { nominal, equipped, activated } = args;
  if (!Number.isSafeInteger(nominal) || nominal < 0) {
    throw new RangeError("EOF Soul Split nominal must be a non-negative integer");
  }
  if (!equipped || !activated || nominal === 0) return nominal;
  const bonus = args.bonusFraction;
  if (bonus === undefined || !Number.isFinite(bonus) ||
      bonus < EOF_SOUL_SPLIT_BONUS_MIN || bonus > EOF_SOUL_SPLIT_BONUS_MAX) {
    throw new RangeError("EOF Soul Split bonus fraction must be between 0.25 and 0.5");
  }
  return Math.floor(nominal * (1 + bonus));
}
