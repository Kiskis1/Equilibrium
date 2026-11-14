import { describe, expect, it } from "vitest";
import { sampleRealizedHit } from "./calculateHit";
import { ripperDemonPassiveModifier } from "../shared/familiarDamage";

describe("RS3 exact integer hosted hit boundaries", () => {
  const draw = (...rolls: number[]) => {
    let cursor = 0;
    return () => rolls[cursor++] ?? 0;
  };
  it("uses host-only near-integer correction at crit and DP stages", () => {
    const input = {
      base: 100, band: { minPct: 100, maxPct: 100 },
      level: 20, accuracy: 1, crit: { chance: 1 },
      random: draw(0, 0), hostRounding: "rs3-host" as const,
    };
    expect(sampleRealizedHit(input).damage).toBe(115);
    expect(sampleRealizedHit({ ...input, random: draw(0, 0), hostRounding: undefined }).damage).toBe(114);
    expect(sampleRealizedHit({
      ...input, level: 99, crit: { chance: 0 }, accuracy: 0.29,
      random: draw(0, 0),
    }).damage).toBe(29);
  });
  it("keeps one host-owned Ripper modifier and does not alter default fork semantics", () => {
    const modifier = ripperDemonPassiveModifier({
      targetLife: 500, targetMaxLife: 1000, hostRounding: "rs3-host",
    });
    expect(modifier).not.toBeNull();
    const r = sampleRealizedHit({
      base: 120, band: { minPct: 100, maxPct: 100 }, level: 20,
      accuracy: 1, crit: { chance: 0, eligible: false }, modifiers: [modifier!],
      random: draw(0), hostRounding: "rs3-host",
    });
    expect(r.damage).toBe(123);
  });
});
