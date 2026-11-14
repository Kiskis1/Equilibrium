import { describe, expect, it } from "vitest";
import { drainHostEvents, nextHostTick, scheduleHostEvent } from "./hostClock";
import { seededXorshift32 } from "./randomStream";

type Event = { tick: number; order: number; type: string; payload?: number };

describe("host-facing deterministic encounter event clock", () => {
  it("preserves insertion order, handles same-tick children and stops on death", () => {
    const queue: Event[] = [];
    let order = 0;
    const schedule = (t: number, type: string, payload?: number) => {
      order = scheduleHostEvent(queue, 0, order, t, type, { payload });
    };
    schedule(2, "future");
    schedule(0, "start");
    schedule(0, "sibling");
    const sequence: string[] = [];
    const events = drainHostEvents(queue, 0, () => false, event => {
      sequence.push(event.type);
      if (event.type === "start") schedule(0, "child");
    });
    expect(events).toBe(3);
    expect(sequence).toEqual(["start", "sibling", "child"]);
    expect(queue.map(x => x.type)).toEqual(["future"]);
    expect(nextHostTick(0)).toBe(1);

    let terminated = false;
    schedule(1, "lethal");
    schedule(1, "ignored");
    const count = drainHostEvents(queue, 1, () => terminated, e => {
      sequence.push(e.type);
      if (e.type === "lethal") terminated = true;
    });
    expect(count).toBe(1);
    expect(queue.some(e => e.type === "ignored")).toBe(true);
  });

  it("produces the exact historic xorshift32 stream, with separate recoverable RNG streams", () => {
    const old = (seed: number) => {
      let state = seed >>> 0 || 0x9e3779b9;
      return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
      };
    };
    for (const seed of [0, 1, 73, 0xffffffff, 0x13579bdf]) {
      const stream = seededXorshift32(seed);
      const legacy = old(seed);
      for (let i = 0; i < 100; i++) expect(stream()).toBe(legacy());
    }
    const a = seededXorshift32(123);
    a(); a(); a();
    const state = a.getState();
    const b = seededXorshift32(2);
    b.setState(state);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });

  it("rejects malformed time, event insertion and restored RNG state", () => {
    expect(() => nextHostTick(-1)).toThrow();
    expect(() => scheduleHostEvent<Event>([], 5, 0, 4, "bad", {})).toThrow();
    expect(() => drainHostEvents<Event>([], -1, () => false, () => {})).toThrow();
    expect(() => seededXorshift32(1).setState(-1)).toThrow();
  });
});
