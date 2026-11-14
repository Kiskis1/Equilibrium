import type { AbilitySpec } from "../../pipeline/calculateAbility";
import {
  finishPreparedCast,
  prepareCastNow,
  startPreparedCast,
  type StartedCast,
} from "../cast";
import { advanceTo, settleCurrentTick } from "../runtime/clock";
import { createRuntime } from "../runtime/runtime";
import { DEFAULT_STOCHASTIC_LANES } from "../runtime/stochastic";
import { firstLegalTickFor } from "../runtime/state";
import type { ResolvedEvent } from "../runtime/events";
import type { RotationState } from "../runtime/state";
import type {
  CastContextInput,
  CastRng,
  RotationSummary,
  SimulateOptions,
} from "./contracts";
import { finish } from "./summary";

/**
 * An opt-in, single-lane, one-tick rotation driver. This is NOT an encounter
 * model: the caller supplies enemies, targetability, movement, incoming damage,
 * and termination. The existing simulate() / simulateRevolution() drivers do
 * not use this API, and their cast/GCD contracts remain unchanged.
 */
export interface SteppedCastResult {
  ok: boolean;
  processedTick: number;
  nextTick: number;
  busyUntilTick: number;
  cast?: string;
  error?: string;
  /** Canonically landed Equilibrium events for the processed tick. */
  events: readonly ResolvedEvent[];
}

export interface SteppedCastContext {
  /** Current action tick, not the next available GCD time. */
  getState(): RotationState;
  busyUntilTick(): number;
  firstLegalTick(abilityId: string): number;
  /** One action at current tick, or null/omitted to wait. Rejects without advancing time. */
  step(abilityId?: string | null, rng?: CastRng): SteppedCastResult;
  /** Call only after all pending cast occupancy has completed. */
  finish(error?: string, horizonTicks?: number, options?: SimulateOptions): RotationSummary;
  byId: ReadonlyMap<string, AbilitySpec>;
}

/**
 * Current-tick ordering (consistent with Equilibrium's existing rotation driver):
 *   1. Settle previously scheduled events due at tick t.
 *   2. Complete an older channel ending at t.
 *   3. Start the requested cast at t (without skipping time).
 *   4. Resolve same-tick hits.
 *   5. Cross into t+1, deliberately leaving t+1 hits for its own step.
 *
 * An actor that resolves new casts before old same-tick hits (e.g. RS3
 * encounter.step) is not automatically parity-compatible. The bridge must
 * check this ordering before handing over authoritative Gym state.
 */
export function createSteppedCastContext(input: CastContextInput): SteppedCastContext {
  const rt = createRuntime(input, { laneIndex: 0, laneCount: DEFAULT_STOCHASTIC_LANES });
  let active: StartedCast | null = null;

  const busyUntilTick = () => active?.completesAt ?? rt.state.tick;

  return {
    getState: () => rt.state,
    busyUntilTick,
    firstLegalTick: (abilityId) => {
      const spec = rt.byId.get(abilityId);
      if (!spec) throw new Error(`unknown ability: ${abilityId}`);
      return Math.max(busyUntilTick(), firstLegalTickFor(rt.state, spec, rt.input.level));
    },
    step: (abilityId = null, rng) => {
      if (rt.finalized) throw new Error("Stepped runtime already finalized");
      const t = rt.state.tick;
      if (rt.horizon !== undefined && t >= rt.horizon) {
        return { ok: false, error: "Simulation horizon reached", processedTick: t,
          nextTick: t, busyUntilTick: busyUntilTick(), events: [] };
      }
      const spec = abilityId === null ? undefined : rt.byId.get(abilityId);
      if (abilityId !== null && !spec) {
        return { ok: false, error: `unknown ability: ${abilityId}`,
          processedTick: t, nextTick: t, busyUntilTick: busyUntilTick(), events: [] };
      }
      if (spec?.offGcd) {
        return { ok: false, error: "Off-GCD casts need a separate action contract",
          processedTick: t, nextTick: t, busyUntilTick: busyUntilTick(), events: [] };
      }
      if (active && spec && t < active.completesAt) {
        return { ok: false, error: `Cast occupied until tick ${active.completesAt}`,
          processedTick: t, nextTick: t, busyUntilTick: busyUntilTick(), events: [] };
      }

      const before = rt.events.length;
      settleCurrentTick(rt);
      if (active && t >= active.completesAt) {
        finishPreparedCast(rt, active);
        active = null;
      }
      if (spec) {
        const attempt = prepareCastNow(rt, spec, rng);
        if (!attempt.ok) {
          return { ok: false, error: attempt.error, processedTick: t,
            nextTick: t, busyUntilTick: busyUntilTick(), events: [] };
        }
        active = startPreparedCast(rt, attempt.prepared, false, attempt.rng);
      }
      settleCurrentTick(rt);
      const events = rt.events.slice(before);
      advanceTo(rt, t + 1, { deferTargetEvents: true });
      return { ok: true, processedTick: t, nextTick: rt.state.tick,
        busyUntilTick: busyUntilTick(), ...(spec ? { cast: spec.id } : {}), events };
    },
    finish: (error, horizonTicks, options) => {
      if (active) {
        throw new Error("Cannot finish stepped runtime with unfinished cast occupancy");
      }
      return finish(rt, error, horizonTicks ?? input.horizonTicks, options);
    },
    byId: rt.byId,
  };
}
