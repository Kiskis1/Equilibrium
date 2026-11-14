/**
 * The production, single-tick execution loop for hosted RS3 encounters.
 *
 * Equilibrium owns ordering, clock progression, event draining and the timeout
 * boundary. Hosts supply boss-specific movement, food, prayer, buffs, casts,
 * incoming/outgoing event handlers and diagnostics as callbacks. All durable
 * state (tick, queue, order, RNG streams, HP, cooldowns) stays in the actor
 * supplied by the host so snapshots contain the entire encounter.
 *
 * This is NOT createSteppedCastContext: the latter targets a generic dummy
 * and has a different event/RNG contract. It must not run in parallel with
 * this host loop or introduce a second source of actor state.
 */
import { drainHostEvents, nextHostTick, type HostQueuedEvent } from "./hostClock";

export interface HostedEncounterTickState<E extends HostQueuedEvent> {
  tick: number;
  queue: E[];
  terminated: boolean;
  truncated: boolean;
  outcome: string | null;
}

export interface HostedEncounterTickCallbacks<E extends HostQueuedEvent> {
  /** All caller-side legality checks must complete before entering this loop. */
  applyAction(): void;
  /** Run the host's channel validity check after casting, before event landing. */
  afterAction(): void;
  /** Boss-specific event resolution, HP, conjures, channels and death effects. */
  handleEvent(event: E): void;
  /** Preserve channel check after EVERY landed event, including same-tick children. */
  afterEvent(): void;
  /** Prayer drain and other costs that occur after all hits at tick t. */
  afterEvents(): void;
  /** Expire resource windows after moving from t to t+1. */
  expireResources(): void;
  /** Record the timeout after the engine sets truncated/outcome. */
  onTimeout(): void;
  /** Encounter-specific termination and boss completion. */
  finishEncounter(): void;
  /** Final channel check after finishEncounter. */
  afterFinish(): void;
}

export interface HostedEncounterTickResult {
  readonly processedTick: number;
  readonly nextTick: number;
  readonly eventsProcessed: number;
}

/**
 * Resolve EXACTLY one action tick in the original encounter order.
 * No independent queue, time, hidden RNG or cached battle state.
 *
 * 1. Commit the host action (may enqueue same-tick hits).
 * 2. Check channels, then drain due events in (tick, order) sequence.
 * 3. Apply post-impact resource costs (e.g. prayer), step one tick.
 * 4. Expire timed effects, mark timeout, then finish boss phase/episode.
 */
export function runHostedEncounterTick<E extends HostQueuedEvent>(
  actor: HostedEncounterTickState<E>,
  maxTicks: number,
  callbacks: HostedEncounterTickCallbacks<E>,
): HostedEncounterTickResult {
  if (!Number.isSafeInteger(actor.tick) || actor.tick < 0 ||
      !Number.isSafeInteger(maxTicks) || maxTicks < 1 ||
      !Array.isArray(actor.queue)) {
    throw new RangeError("Invalid hosted encounter clock or horizon");
  }
  if (actor.terminated || actor.truncated) {
    throw new Error("Episode finished; reset before stepping");
  }
  const processedTick = actor.tick;
  const queue = actor.queue;
  callbacks.applyAction();
  callbacks.afterAction();
  // Preserve the same queue array for same-tick children and snapshot replay.
  // Replacing it during boss phases previously caused skipped impacts/deaths.
  if (actor.tick !== processedTick || actor.queue !== queue) {
    throw new Error("Hosted action replaced the live tick or event queue");
  }
  const eventsProcessed = drainHostEvents(
    queue,
    processedTick,
    () => actor.terminated,
    event => callbacks.handleEvent(event),
    () => callbacks.afterEvent(),
  );
  if (actor.tick !== processedTick || actor.queue !== queue) {
    throw new Error("Hosted event handler replaced the live tick or event queue");
  }
  callbacks.afterEvents();
  actor.tick = nextHostTick(processedTick);
  callbacks.expireResources();
  if (!actor.terminated && actor.tick >= maxTicks) {
    actor.truncated = true;
    actor.outcome = "timeout";
    callbacks.onTimeout();
  }
  callbacks.finishEncounter();
  callbacks.afterFinish();
  return { processedTick, nextTick: actor.tick, eventsProcessed };
}
