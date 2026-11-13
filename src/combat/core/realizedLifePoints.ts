/**
 * Pure, host-neutral HP settlement for concrete (not expected-value) combat.
 *
 * The encounter chooses its target, immunities, protection mechanics, damage
 * and healing. This module is the single numerical authority for committing
 * those already-resolved values to an HP pool. It never changes RNG, emits
 * events or schedules boss mechanics.
 *
 * Numeric values remain finite non-negative numbers rather than being rounded
 * again: hosts already apply floor/mitigation rules before settlement. That
 * prevents a second floor, which would silently change legacy fight results.
 */
export interface RealizedDamageInput {
  readonly currentLife: number;
  readonly damage: number;
}

export interface RealizedDamageSettlement {
  readonly lifeBefore: number;
  readonly lifeAfter: number;
  readonly appliedDamage: number;
  readonly overkill: number;
  /** Also true if the caller supplies an already depleted HP pool. */
  readonly dead: boolean;
}

export interface RealizedHealInput {
  readonly currentLife: number;
  readonly maxLife: number;
  readonly healing: number;
}

export interface RealizedHealSettlement {
  readonly lifeBefore: number;
  readonly lifeAfter: number;
  readonly appliedHealing: number;
  readonly excessHealing: number;
}

function nonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`realizedLifePoints: invalid ${label}`);
  }
}

/** Apply one final landed hit after all host-specific mitigation. */
export function settleRealizedDamage(input: RealizedDamageInput): RealizedDamageSettlement {
  nonNegativeFinite(input.currentLife, "currentLife");
  nonNegativeFinite(input.damage, "damage");
  const appliedDamage = Math.min(input.currentLife, input.damage);
  const lifeAfter = input.currentLife - appliedDamage;
  return {
    lifeBefore: input.currentLife,
    lifeAfter,
    appliedDamage,
    overkill: input.damage - appliedDamage,
    dead: lifeAfter <= 0,
  };
}

/** Apply one resolved heal without surpassing the supplied current-life cap. */
export function settleRealizedHealing(input: RealizedHealInput): RealizedHealSettlement {
  nonNegativeFinite(input.currentLife, "currentLife");
  nonNegativeFinite(input.maxLife, "maxLife");
  nonNegativeFinite(input.healing, "healing");
  if (input.currentLife > input.maxLife) {
    throw new RangeError("realizedLifePoints: currentLife exceeds maxLife");
  }
  const appliedHealing = Math.min(input.healing, input.maxLife - input.currentLife);
  return {
    lifeBefore: input.currentLife,
    lifeAfter: input.currentLife + appliedHealing,
    appliedHealing,
    excessHealing: input.healing - appliedHealing,
  };
}
