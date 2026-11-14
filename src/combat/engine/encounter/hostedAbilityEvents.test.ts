import { describe, expect, it } from "vitest";
import { SOUL_STRIKE_SECONDARY_DAMAGE_BAND } from "../../shared/hostedDamage";
import {
  planHostedChannelEvents,
  planHostedNecromancyImpacts,
  planHostedSkullsStart,
} from "./hostedAbilityEvents";

const basicHit = { band: { minPct: 90, maxPct: 110 } };

describe("stateless Equilibrium hosted ability event plans", () => {
  it("keeps primary, Threads victims and AoE victims in old host insertion order", () => {
    const hit = { ...basicHit, tickOffset: 2 };
    const events = planHostedNecromancyImpacts({
      tick: 18,
      castId: 13,
      target: "boss",
      ability: { id: "soul_sap", soulGain: 1, soulChance: 0.2, hits: [hit] },
      threadsTargets: ["minion_a", "minion_b"],
      areaTargets: ["minion_c"],
      soulReaveGrant: true,
    });
    expect(events.map(({ tick, type, data }) => [tick, type, data.target]))
      .toEqual([
        [20, "outgoing", "boss"],
        [20, "outgoing", "minion_a"],
        [20, "outgoing", "minion_b"],
        [20, "outgoing", "minion_c"],
      ]);
    expect(events[0]?.data).toEqual({
      target: "boss",
      hit,
      ability: "soul_sap",
      soulGain: 1,
      soulChance: 0.2,
      derived: undefined,
      necroCastId: 13,
      provenance: "player_direct",
      soulStrikeControl: false,
      soulReaveCastId: 13,
    });
    expect(events[1]?.data).toMatchObject({
      threadCopy: true, soulGain: 1, soulReaveCastId: 13,
    });
    expect(events[3]?.data).toEqual({
      target: "minion_c", hit, ability: "soul_sap",
      soulChance: 0.2, necroCastId: 13, provenance: "player_direct",
    });
  });

  it("Bloat keeps delayed thread children only on its primary impact", () => {
    const derivedHits = {
      count: 5, firstOffset: 2, intervalTicks: 2,
      fractionPct: 25, dot: true,
    };
    const events = planHostedNecromancyImpacts({
      tick: 4, castId: 7, target: "boss",
      ability: { id: "bloat", hits: [basicHit], derivedHits },
      threadsTargets: ["minion_a", "minion_b"],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      target: "boss", ability: "bloat", derived: derivedHits,
      threadBloatCopies: [{ target: "minion_a" }, { target: "minion_b" }],
    });
    expect(events[0]?.data).not.toHaveProperty("threadCopy");
  });

  it("Soul Strike secondary hits use pinned separate damage band", () => {
    const events = planHostedNecromancyImpacts({
      tick: 12, castId: 3, target: "boss",
      ability: { id: "soul_strike", hits: [basicHit] },
      areaTargets: ["minion_a"],
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toMatchObject({ soulStrikeControl: true });
    expect(events[1]?.data.hit).toEqual({ band: SOUL_STRIKE_SECONDARY_DAMAGE_BAND });
    expect(events[1]?.data).not.toHaveProperty("soulStrikeControl");
    expect(events[1]?.data).not.toHaveProperty("soulGain");
  });

  it("preserves hit-major, victim-minor ordering for multiple offsets", () => {
    const hits = [basicHit, { ...basicHit, tickOffset: 4 }];
    const result = planHostedNecromancyImpacts({
      tick: 10, castId: 8, target: "boss",
      ability: { id: "spectral_scythe", hits },
      areaTargets: ["arm"],
    });
    expect(result.map(e => [e.tick, e.data.target]))
      .toEqual([[10, "boss"], [10, "arm"], [14, "boss"], [14, "arm"]]);
  });

  it("Death Skulls initial bounce and Blood Siphon pulse events have exact order", () => {
    const rules = { initial_delay: 1, hop_ticks: 2 };
    const skull = planHostedSkullsStart({
      tick: 9, castId: 20, target: "boss", remaining: 3,
      rules, origin: [2, 3], destination: [4, 5], hit: basicHit,
    });
    expect(skull).toEqual({
      tick: 10, type: "skulls",
      data: {
        target: "boss", castId: 20, remaining: 3,
        rules, origin: [2, 3], destination: [4, 5],
        initial: true, host: null, hit: basicHit,
      },
    });

    const channel = planHostedChannelEvents({
      tick: 10, channelId: 4, pulseOffsets: [2, 3, 4],
      finisherOffset: 6,
    });
    expect(channel).toEqual([
      { tick: 12, type: "channel", data: { channelId: 4, kind: "pulse" } },
      { tick: 13, type: "channel", data: { channelId: 4, kind: "pulse" } },
      { tick: 14, type: "channel", data: { channelId: 4, kind: "pulse" } },
      { tick: 16, type: "channel", data: { channelId: 4, kind: "finish" } },
    ]);
  });

  it("does not mutate input or create RNG and fails closed on invalid plans", () => {
    const input = {
      tick: 10, castId: 2, target: "boss",
      ability: { id: "necromancy_basic", hits: [basicHit] },
      threadsTargets: ["arm"],
    };
    const before = JSON.stringify(input);
    planHostedNecromancyImpacts(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(() => planHostedNecromancyImpacts({
      ...input, threadsTargets: ["boss"],
    })).toThrow(/Invalid hosted target list/);
    expect(() => planHostedNecromancyImpacts({
      ...input, ability: { id: "death_skulls", hits: [basicHit] },
    })).toThrow(/bouncing host event planner/);
    expect(() => planHostedNecromancyImpacts({
      ...input, ability: {
        id: "bad", hits: [{ ...basicHit, tickOffset: -1 }],
      },
    })).toThrow(/Invalid hosted hit/);
    expect(() => planHostedChannelEvents({
      tick: 0, channelId: 1, pulseOffsets: [3, 2],
      finisherOffset: 5,
    })).toThrow(/Invalid hosted channel/);
    expect(() => planHostedSkullsStart({
      tick: 0, castId: 1, target: "", remaining: 2,
      rules: { initial_delay: 1 },
      origin: [0, 0], destination: [1, 1], hit: basicHit,
    })).toThrow(/Invalid hosted Death Skulls/);
  });
});
