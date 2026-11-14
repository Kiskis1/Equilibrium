import { describe, expect, it } from "vitest";
import { scheduleHostEvent } from "./hostClock";
import {
  runHostedEncounterTick,
  type HostedEncounterTickCallbacks,
  type HostedEncounterTickState,
} from "./hostEncounterTick";

type Event = { tick: number; order: number; type: string; damage?: number };
type State = HostedEncounterTickState<Event>;

function createHost(maxTicks = 3) {
  const state: State = {
    tick: 0, queue: [], terminated: false, truncated: false, outcome: null,
  };
  let order = 0;
  const log: string[] = [];
  const queue = (tick: number, type: string, damage?: number) => {
    order = scheduleHostEvent(state.queue, state.tick, order, tick, type, { damage });
  };
  const callbacks: HostedEncounterTickCallbacks<Event> = {
    applyAction: () => { log.push("action"); queue(state.tick, "hit", 8); },
    afterAction: () => { log.push("after-action"); },
    handleEvent: event => {
      log.push(event.type);
      if (event.type === "hit") queue(state.tick, "child", 3);
    },
    afterEvent: () => { log.push("after-event"); },
    afterEvents: () => { log.push("prayer"); },
    expireResources: () => { log.push("expire"); },
    onTimeout: () => { log.push("timeout"); },
    finishEncounter: () => { log.push("finish"); },
    afterFinish: () => { log.push("after-finish"); },
  };
  return { state, callbacks, queue, log, maxTicks };
}

describe("Equilibrium source-owned live encounter tick", () => {
  it("runs action-first, same-tick children, post-hit costs and termination in exact order", () => {
    const host = createHost();
    const first = runHostedEncounterTick(host.state, host.maxTicks, host.callbacks);
    expect(first).toEqual({ processedTick: 0, nextTick: 1, eventsProcessed: 2 });
    expect(host.log).toEqual([
      "action", "after-action", "hit", "after-event",
      "child", "after-event", "prayer", "expire", "finish", "after-finish",
    ]);
    expect(host.state.queue).toHaveLength(0);
    expect(host.state.terminated).toBe(false);
  });

  it("does not skip future events and times out AFTER resource expiry on the final tick", () => {
    const host = createHost(2);
    host.queue(1, "future");
    const first = runHostedEncounterTick(host.state, host.maxTicks, host.callbacks);
    expect(first).toEqual({ processedTick: 0, nextTick: 1, eventsProcessed: 2 });
    expect(host.state.queue.map(e => e.type)).toEqual(["future"]);
    host.log.length = 0;
    const second = runHostedEncounterTick(host.state, host.maxTicks, host.callbacks);
    expect(second).toEqual({ processedTick: 1, nextTick: 2, eventsProcessed: 3 });
    expect(host.log).toEqual([
      "action", "after-action", "future", "after-event", "hit", "after-event",
      "child", "after-event", "prayer", "expire", "timeout", "finish", "after-finish",
    ]);
    expect(host.state.truncated).toBe(true);
    expect(host.state.outcome).toBe("timeout");
    expect(() => runHostedEncounterTick(host.state, host.maxTicks, host.callbacks))
      .toThrow(/Episode finished/);
  });

  it("ceases draining on lethal incoming events without skipping end-of-tick housekeeping", () => {
    const host = createHost();
    host.callbacks.handleEvent = event => {
      host.log.push(event.type);
      if (event.type === "lethal") {
        host.state.terminated = true;
        host.state.outcome = "death";
      }
    };
    host.queue(0, "lethal");
    host.queue(0, "ignored");
    const done = runHostedEncounterTick(host.state, host.maxTicks, host.callbacks);
    expect(done.eventsProcessed).toBe(1);
    expect(done.nextTick).toBe(1);
    expect(host.state.queue.some(e => e.type === "ignored")).toBe(true);
    expect(host.log.includes("ignored")).toBe(false);
    expect(host.log.slice(-4)).toEqual(["prayer", "expire", "finish", "after-finish"]);
    expect(host.state.outcome).toBe("death");
    expect(host.state.truncated).toBe(false);
  });

  it("rejects stale terminal states and illegal time without mutating the actor", () => {
    const host = createHost();
    const queue = host.state.queue;
    host.state.tick = -1;
    expect(() => runHostedEncounterTick(host.state, host.maxTicks, host.callbacks))
      .toThrow(/Invalid hosted/);
    expect(host.state.queue).toBe(queue);
    expect(host.log).toEqual([]);
    host.state.tick = 0;
    host.state.terminated = true;
    expect(() => runHostedEncounterTick(host.state, host.maxTicks, host.callbacks))
      .toThrow(/Episode finished/);
    expect(host.log).toEqual([]);
  });

  it("detects a handler replacing a queue reference, including a boss phase change", () => {
    const host = createHost();
    host.callbacks.handleEvent = () => {
      host.state.queue = host.state.queue.filter(e => e.tick > host.state.tick);
    };
    expect(() => runHostedEncounterTick(host.state, host.maxTicks, host.callbacks))
      .toThrow(/replaced the live tick or event queue/);
  });
});
