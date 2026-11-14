/**
 * Pure cast commit planning for a host-managed tick-by-tick encounter.
 *
 * Uses the exact same adrenaline transaction and timing rules as the shared
 * combat engine. The host retains encounter-specific legality, target choice,
 * buffs, equipment triggers, special RNG and event/HP application.
 *
 * This is deliberately a STATELESS calculation. Do not introduce another
 * combat runtime whose state would be omitted from RS3 Gym snapshots.
 */
import {
  resolveAdrenalineTransaction,
  type AdrenalineTransaction,
} from "../../shared/adrenalineTransaction";
import { secondsToTicks, STANDARD_ATTACK_TICKS } from "../../core/ticks";

export interface HostedCastSpec {
  id: string;
  adrenaline?: { cost?: number; gain?: number } | null;
  cooldownSeconds?: number;
  channelTicks?: number;
}

export interface HostedCastInput {
  tick: number;
  adrenaline: number;
  spec: HostedCastSpec;
  /** Override the cast-specific occupation, e.g. Blood Siphon is 3 ticks. */
  occupancyTicks?: number;
  /** Optional cooldown already measured in ticks, used by sourced defensives. */
  cooldownTicks?: number;
}

export interface HostedCastPlan {
  gcdUntil: number;
  cooldownUntil: number;
  adrenalineAfter: number;
  adrenalineTransaction: AdrenalineTransaction;
}

/**
 * Preview the immediate host cast cost and clocks with NO RNG or mutations.
 *
 * Host model intentionally uses the simple fixed listed gain/cost rules;
 * the normal Equilibrium rotation engine may additionally apply procs,
 * relics and buffs. They are NOT silently imported into the host model.
 * A host applies its own triggered equipment effects in their established
 * order after committing this plan.
 */
export function planHostedCast(input: HostedCastInput): HostedCastPlan {
  const { tick, adrenaline, spec } = input;
  if (!Number.isSafeInteger(tick) || tick < 0 ||
      !Number.isFinite(adrenaline) || adrenaline < 0 || adrenaline > 100 ||
      !spec || typeof spec.id !== "string" || !spec.id) {
    throw new RangeError("Invalid hosted cast tick, resources or spec");
  }
  const occupancy = input.occupancyTicks ?? spec.channelTicks ?? 0;
  const cooldown = input.cooldownTicks ??
    secondsToTicks(spec.cooldownSeconds ?? 0);
  const gain = spec.adrenaline?.gain ?? 0;
  const cost = spec.adrenaline?.cost ?? 0;
  for (const [label, value] of [
    ["occupancy", occupancy], ["cooldown", cooldown],
    ["adrenaline gain", gain], ["adrenaline cost", cost],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 ||
        (label !== "adrenaline gain" && label !== "adrenaline cost" &&
         !Number.isSafeInteger(value))) {
      throw new RangeError("Invalid hosted cast " + label);
    }
  }
  const transaction = resolveAdrenalineTransaction({
    before: adrenaline,
    cap: 100,
    listedCost: cost,
    effectiveCost: cost,
    listedGain: gain,
    isGeneratingBasicAbility: false,
    isBasicAttack: false,
    impatientProc: false,
    relentlessProc: false,
  });
  return {
    gcdUntil: tick + Math.max(STANDARD_ATTACK_TICKS, occupancy),
    cooldownUntil: tick + cooldown,
    adrenalineAfter: transaction.afterResources,
    adrenalineTransaction: transaction,
  };
}
