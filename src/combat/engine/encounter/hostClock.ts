/**
 * A deterministic, tick-addressed host event clock for full encounters.
 *
 * The Equilibrium rotation runtime owns sampled hit and cast-event scheduling.
 * This small host-facing clock owns the ordering of *all* events in a
 * multi-target/boss encounter without assuming a specific boss or Gym schema.
 * It intentionally accepts the host's serializable queue and tick as arguments
 * so there is no hidden state excluded from existing actor snapshots.
 */

export interface HostQueuedEvent {
  tick: number;
  order: number;
  type: string;
}

export function scheduleHostEvent<T extends HostQueuedEvent>(
  queue: T[],
  currentTick: number,
  order: number,
  tick: number,
  type: string,
  data: Omit<T, keyof HostQueuedEvent>,
): number {
  if (!Number.isSafeInteger(currentTick) || currentTick < 0 ||
      !Number.isSafeInteger(tick) || tick < currentTick ||
      !Number.isSafeInteger(order) || order < 0 ||
      typeof type !== "string" || type.length === 0) {
    throw new RangeError("Invalid encounter event schedule");
  }
  queue.push({ ...data, tick, order, type } as T);
  return order + 1;
}

/**
 * Drain all due events in (tick, insertion-order) order, including new
 * same-tick events scheduled by handlers. The caller retains ownership of
 * encounter-specific handling, boss phases, death and channel callbacks.
 */
export function drainHostEvents<T extends HostQueuedEvent>(
  queue: T[],
  tick: number,
  isTerminated: () => boolean,
  handle: (event: T) => void,
  afterEvent: () => void = () => {},
): number {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError("Invalid encounter tick");
  }
  let processed = 0;
  while (!isTerminated()) {
    queue.sort((a, b) => a.tick - b.tick || a.order - b.order);
    if (queue.length === 0 || queue[0]!.tick > tick) break;
    const event = queue.shift()!;
    handle(event);
    afterEvent();
    processed++;
  }
  return processed;
}

/** Advance exactly one encounter action tick. No ability-GCD time skipping. */
export function nextHostTick(tick: number): number {
  if (!Number.isSafeInteger(tick) || tick < 0 || tick === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Invalid encounter tick");
  }
  return tick + 1;
}
