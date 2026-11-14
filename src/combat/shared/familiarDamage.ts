import { floorDamage, mulFloor } from "../core/rounding";
import type { CombatModifier, SourceReference } from "../types";

/**
 * Ripper Demon passive: player damage rises from +0% at full target LP
 * to +5% at zero LP. Does not apply to damage-over-time abilities.
 *
 * Source: https://runescape.wiki/w/Ripper_Demon_(familiar)
 *
 * Only damage mathematics lives here. The caller (RS3 encounter or another
 * combat host) decides whether a familiar is summoned/active, who is targeted,
 * and when damage events land. No RNG, HP changes or event scheduling.
 */
export const RIPPER_DEMON_PASSIVE_SOURCE: SourceReference = {
  source: "runescape-wiki",
  url: "https://runescape.wiki/w/Ripper_Demon_(familiar)",
  title: "Ripper Demon (familiar)",
  verifiedAt: "2026-11-13",
};

export interface RipperDemonDamageInput {
  readonly targetLife: number;
  readonly targetMaxLife: number;
  readonly damageOverTime?: boolean;
  /** Host-only numerical compatibility; generic Equilibrium remains floor-based. */
  readonly hostRounding?: "rs3-host";
}

export function ripperDemonPassiveMultiplier(input: RipperDemonDamageInput): number {
  const { targetLife, targetMaxLife } = input;
  if (!Number.isFinite(targetLife) || targetLife < 0 ||
      !Number.isFinite(targetMaxLife) || targetMaxLife <= 0) {
    throw new RangeError("ripperDemon: invalid target life points");
  }
  if (input.damageOverTime === true) return 1;
  const remainingFraction = Math.max(0, Math.min(1, targetLife / targetMaxLife));
  return 1 + 0.05 * (1 - remainingFraction);
}

/**
 * Shares the canonical ability-stage multiplier and its floor semantics with
 * all Equilibrium consumers; returns null for a neutral/DoT modifier.
 */
export function ripperDemonPassiveModifier(input: RipperDemonDamageInput): CombatModifier | null {
  const multiplier = ripperDemonPassiveMultiplier(input);
  if (multiplier === 1) return null;
  return {
    id: "familiar:ripper-passive",
    stage: "ability",
    priority: 25,
    source: RIPPER_DEMON_PASSIVE_SOURCE,
    applies: () => true,
    apply: state => ({ damage: input.hostRounding === "rs3-host"
      ? floorDamage(state.damage * multiplier)
      : mulFloor(state.damage, multiplier) }),
  };
}
