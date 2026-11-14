/**
 * Serializable, host-targeted ability event plans for one RS3 encounter cast.
 *
 * Shared combat ability mechanics own hit offsets, Threads copy shape, Bloat
 * primary-first semantics and Soul Strike secondary hit bands. The encounter
 * supplies already-selected target IDs after boss-specific range, phase,
 * line-of-sight and targetability checks. Damage is NOT rolled at cast time.
 *
 * The result is deliberately stateless: the host inserts these records in
 * array order through the pinned Equilibrium encounter clock. There is no
 * second RNG, event queue, time source or snapshot to synchronize with Gym.
 */
import type { AbilityHit, DerivedHitsSpec } from "../../pipeline/calculateAbility";
import { SOUL_STRIKE_SECONDARY_DAMAGE_BAND } from "../../shared/hostedDamage";

export interface HostedAbilityHits {
  id: string;
  hits: readonly AbilityHit[];
  derivedHits?: DerivedHitsSpec;
  soulGain?: number;
  soulChance?: number;
}

export interface HostedEventPlan {
  tick: number;
  type: "outgoing" | "skulls" | "channel";
  data: Record<string, unknown>;
}

export interface HostedNecromancyImpactInput {
  tick: number;
  castId: number;
  target: string;
  ability: HostedAbilityHits;
  /** Selected by encounter geometry and availability, sorted by the host. */
  threadsTargets?: readonly string[];
  /** Selected by host range / targeting, sorted by the host. */
  areaTargets?: readonly string[];
  soulReaveGrant?: boolean;
}

function validTickAndCast(tick: number, castId: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0 ||
      !Number.isSafeInteger(castId) || castId < 0) {
    throw new RangeError("Invalid hosted ability tick or cast id");
  }
}

function validTarget(target: string): boolean {
  return typeof target === "string" && target.length > 0;
}

export function planHostedNecromancyImpacts(
  input: HostedNecromancyImpactInput,
): HostedEventPlan[] {
  const { tick, castId, target, ability } = input;
  validTickAndCast(tick, castId);
  if (!validTarget(target) || !ability || !validTarget(ability.id) ||
      !Array.isArray(ability.hits)) {
    throw new RangeError("Invalid hosted ability or target");
  }
  if (ability.id === "death_skulls") {
    throw new Error("Death Skulls requires the bouncing host event planner");
  }
  const threads = input.threadsTargets ?? [];
  const area = input.areaTargets ?? [];
  if (![threads, area].every(ids =>
    Array.isArray(ids) && ids.every(validTarget) &&
    ids.every(id => id !== target) && new Set(ids).size === ids.length)) {
    throw new RangeError("Invalid hosted target list");
  }
  const scheduled: HostedEventPlan[] = [];
  for (const [index, hit] of ability.hits.entries()) {
    const offset = hit?.tickOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !hit?.band || tick + offset > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Invalid hosted hit offset or band");
    }
    const data: Record<string, unknown> = {
      target,
      hit,
      ability: ability.id,
      soulGain: ability.soulGain ?? 0,
      soulChance: ability.soulChance ?? 0,
      derived: index === 0 ? ability.derivedHits : undefined,
      necroCastId: castId,
      provenance: "player_direct",
      soulStrikeControl: ability.id === "soul_strike",
    };
    if (input.soulReaveGrant) data.soulReaveCastId = castId;
    // Threaded Bloat tails are scheduled after resolution of the primary
    // host hit, not at cast time. Copies reuse its resolved damage basis.
    if (ability.id === "bloat" && threads.length > 0) {
      data.threadBloatCopies = threads.map(target => ({ target }));
    }
    const landingTick = tick + offset;
    scheduled.push({ tick: landingTick, type: "outgoing", data });
    if (ability.id !== "bloat") {
      for (const other of threads) {
        scheduled.push({
          tick: landingTick,
          type: "outgoing",
          data: {
            ...data,
            target: other,
            threadCopy: true,
            soulGain: ability.id === "soul_sap" ? (ability.soulGain ?? 0) : 0,
          },
        });
      }
    }
    for (const other of area) {
      scheduled.push({
        tick: landingTick,
        type: "outgoing",
        data: {
          target: other,
          hit: ability.id === "soul_strike"
            ? { band: SOUL_STRIKE_SECONDARY_DAMAGE_BAND }
            : hit,
          ability: ability.id,
          soulChance: ability.soulChance ?? 0,
          necroCastId: castId,
          provenance: "player_direct",
        },
      });
    }
  }
  return scheduled;
}

export interface HostedSkullsStart {
  tick: number;
  castId: number;
  target: string;
  remaining: number;
  rules: { initial_delay: number; [key: string]: unknown };
  origin: readonly [number, number];
  destination: readonly [number, number];
  hit: AbilityHit;
}

/** Initial Death Skulls landing only; boss-target bounce selection is hosted. */
export function planHostedSkullsStart(input: HostedSkullsStart): HostedEventPlan {
  validTickAndCast(input.tick, input.castId);
  if (!validTarget(input.target) ||
      !Number.isSafeInteger(input.remaining) || input.remaining < 0 ||
      !Number.isSafeInteger(input.rules?.initial_delay) ||
      input.rules.initial_delay < 0 ||
      !input.hit?.band ||
      ![input.origin, input.destination].every(point =>
        Array.isArray(point) && point.length === 2 &&
        point.every(Number.isFinite))) {
    throw new RangeError("Invalid hosted Death Skulls initial event");
  }
  return {
    tick: input.tick + input.rules.initial_delay,
    type: "skulls",
    data: {
      target: input.target,
      castId: input.castId,
      remaining: input.remaining,
      rules: input.rules,
      origin: [...input.origin],
      destination: [...input.destination],
      initial: true,
      host: null,
      hit: input.hit,
    },
  };
}

export interface HostedChannelStart {
  tick: number;
  channelId: number;
  pulseOffsets: readonly number[];
  finisherOffset: number;
}

/** Blood Siphon channel pulse/finish events, preserving declared order. */
export function planHostedChannelEvents(input: HostedChannelStart): HostedEventPlan[] {
  validTickAndCast(input.tick, input.channelId);
  if (!Array.isArray(input.pulseOffsets) ||
      !Number.isSafeInteger(input.finisherOffset) || input.finisherOffset < 1 ||
      input.pulseOffsets.some((offset, i) =>
        !Number.isSafeInteger(offset) || offset < 1 ||
        offset >= input.finisherOffset ||
        (i > 0 && offset <= input.pulseOffsets[i - 1]!))) {
    throw new RangeError("Invalid hosted channel pulse schedule");
  }
  return [
    ...input.pulseOffsets.map(offset => ({
      tick: input.tick + offset,
      type: "channel" as const,
      data: { channelId: input.channelId, kind: "pulse" },
    })),
    {
      tick: input.tick + input.finisherOffset,
      type: "channel" as const,
      data: { channelId: input.channelId, kind: "finish" },
    },
  ];
}

export interface HostedSkullsHop {
  tick: number;
  previous: {
    remaining: number;
    rules: { range: number; edge_hop_ticks: number; hop_ticks: number };
    [key: string]: unknown;
  };
  next: { target: string; destination: readonly [number, number] };
  origin: readonly [number, number];
  host: unknown;
  travelDistance: number;
}

/** Pure Death Skulls follow-up hop; host decides the next eligible target. */
export function planHostedSkullsHop(input: HostedSkullsHop): HostedEventPlan {
  const { previous, next, tick } = input;
  const rules = previous?.rules;
  if (!Number.isSafeInteger(tick) || tick < 0 ||
      !Number.isSafeInteger(previous?.remaining) || previous.remaining < 1 ||
      !validTarget(next?.target) || !rules ||
      !Number.isFinite(input.travelDistance) || input.travelDistance < 0 ||
      !Number.isFinite(rules.range) || rules.range < 0 ||
      !Number.isSafeInteger(rules.hop_ticks) || rules.hop_ticks < 1 ||
      !Number.isSafeInteger(rules.edge_hop_ticks) || rules.edge_hop_ticks < 1 ||
      ![input.origin, next.destination].every(point =>
        Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
    throw new RangeError("Invalid hosted Death Skulls hop");
  }
  const delay = input.travelDistance >= rules.range
    ? rules.edge_hop_ticks
    : rules.hop_ticks;
  return {
    tick: tick + delay,
    type: "skulls",
    // Preserve existing metadata including castId and inherited first-hit
    // damage. No damage or critical RNG is rolled for a derived bounce.
    data: {
      ...previous,
      ...next,
      origin: input.origin,
      host: input.host,
      initial: false,
      remaining: previous.remaining - 1,
    },
  };
}
