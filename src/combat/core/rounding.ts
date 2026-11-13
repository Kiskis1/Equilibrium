/**
 * RS applies modifiers to floored intermediates, then floors again. Compose these in
 * sequence; never rewrite a floor(A) -> mod -> floor(B) chain as floor(A*B).
 */
/** Restore a value an exact integer away only by floating-point representation.
 * This is a numerical guard, never a game modifier or a changed floor stage.
 * RS3's former Node loader used precisely the same guard. */
export function floorDamage(value: number): number {
  const nearest = Math.round(value);
  if (Number.isSafeInteger(nearest) && nearest > value &&
      nearest - value <= Number.EPSILON * Math.abs(value)) return nearest;
  return Math.floor(value);
}

export function mulFloor(value: number, factor: number): number {
  return Math.floor(value * factor);
}

export function percentFloor(value: number, percent: number): number {
  return Math.floor((value * percent) / 100);
}
