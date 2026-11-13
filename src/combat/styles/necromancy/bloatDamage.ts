import { BLOAT_DOT_FRACTION } from "./abilities";

/**
 * Bloat's concrete DoT amount is 25% of the already-resolved initial hit.
 * Every tail reuses this one rounded value; it is not a fresh hit roll.
 *
 * This is a damage calculator only. The consuming encounter owns target HP,
 * event timing, queue, death spread and any collision with an active effect.
 */
export function resolvedBloatTailDamage(
  resolvedInitialDamage: number,
  fractionPct = BLOAT_DOT_FRACTION * 100,
): number {
  if (!Number.isFinite(resolvedInitialDamage) || resolvedInitialDamage < 0) {
    throw new RangeError("bloatDamage: invalid resolved initial hit");
  }
  if (!Number.isFinite(fractionPct) || fractionPct < 0) {
    throw new RangeError("bloatDamage: invalid tail fraction");
  }
  const damage = Math.floor((resolvedInitialDamage * fractionPct) / 100);
  if (!Number.isSafeInteger(damage)) {
    throw new RangeError("bloatDamage: resolved tail overflow");
  }
  return damage;
}
