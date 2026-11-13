import {
  BLOAT_DOT_FRACTION,
  BLOAT_DOT_HITS,
  BLOAT_DOT_TICK_INTERVAL,
} from "./abilities";

/**
 * One realized Bloat state transition. The combat encounter chooses targets,
 * token validity, time of application and death-spread victims; the shared
 * Necromancy rule owns damage fraction and the numbered periodic hits.
 *
 * No mutable game state or RNG is held here. The returned state is JSON-safe.
 */
export interface BloatDotState {
  readonly id: number;
  readonly token: number;
  readonly damage: number;
  readonly potential: number;
  readonly castId: number | null;
  readonly remaining: number;
  readonly nextTick: number;
  readonly spread: boolean;
}

export interface NewBloatDotInput {
  readonly id: number;
  readonly token: number;
  readonly damage: number;
  readonly potential: number;
  readonly castId?: number | null;
  readonly tick: number;
  readonly hits?: number;
  readonly firstOffset?: number;
  readonly spread?: boolean;
}

export interface NewBloatDot {
  readonly dot: BloatDotState;
  readonly untilTick: number;
}

function nonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`bloatRuntime: invalid ${field}`);
  }
}

function integer(value: number, field: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`bloatRuntime: invalid ${field}`);
  }
}

export function resolvedBloatTailDamage(
  resolvedInitialDamage: number,
  fractionPct: number = BLOAT_DOT_FRACTION * 100,
): number {
  nonnegative(resolvedInitialDamage, "resolvedInitialDamage");
  nonnegative(fractionPct, "fractionPct");
  return Math.floor((resolvedInitialDamage * fractionPct) / 100);
}

export function newBloatDot(input: NewBloatDotInput): NewBloatDot {
  const hits = input.hits ?? BLOAT_DOT_HITS;
  const firstOffset = input.firstOffset ?? BLOAT_DOT_TICK_INTERVAL;
  integer(input.id, "id");
  integer(input.token, "token", false);
  integer(input.tick, "tick");
  integer(hits, "hits", false);
  integer(firstOffset, "firstOffset");
  if (input.castId != null) integer(input.castId, "castId");
  nonnegative(input.damage, "damage");
  nonnegative(input.potential, "potential");
  const first = input.tick + firstOffset;
  const untilTick = first + (hits - 1) * BLOAT_DOT_TICK_INTERVAL + 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(untilTick)) {
    throw new RangeError("bloatRuntime: tick overflow");
  }
  return {
    dot: {
      id: input.id,
      token: input.token,
      damage: input.damage,
      potential: input.potential,
      castId: input.castId ?? null,
      remaining: hits,
      nextTick: first,
      spread: input.spread ?? false,
    },
    untilTick,
  };
}

/** Called for exactly one VALID, due tick. The host validates target and token. */
export function advanceBloatDot(dot: BloatDotState, tick: number): BloatDotState {
  integer(tick, "tick");
  integer(dot.remaining, "remaining", false);
  if (dot.nextTick !== tick) {
    throw new RangeError("bloatRuntime: Bloat tick out of order");
  }
  const remaining = dot.remaining - 1;
  return {
    ...dot,
    remaining,
    nextTick: remaining > 0 ? tick + BLOAT_DOT_TICK_INTERVAL : tick,
  };
}

export type BloatCollisionPolicy = "preserve" | "stronger" | "replace";

/** Geometry and eligibility remain encounter-owned; this is only collision priority. */
export function shouldOverwriteBloat(input: {
  readonly existingDamage?: number | null;
  readonly existingUntilTick?: number;
  readonly incomingDamage: number;
  readonly tick: number;
  readonly policy: BloatCollisionPolicy;
}): boolean {
  nonnegative(input.incomingDamage, "incomingDamage");
  integer(input.tick, "tick");
  if (input.policy !== "preserve" && input.policy !== "stronger" && input.policy !== "replace") {
    throw new RangeError("bloatRuntime: invalid collision policy");
  }
  if (input.existingDamage == null || input.existingUntilTick == null) return true;
  nonnegative(input.existingDamage, "existingDamage");
  integer(input.existingUntilTick, "existingUntilTick");
  if (input.tick >= input.existingUntilTick) return true;
  if (input.policy === "preserve") return false;
  return input.policy === "replace" || input.existingDamage < input.incomingDamage;
}
