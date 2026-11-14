/**
 * Serializable xorshift32 streams shared by boss hosts and Gym encounters.
 * Stream split identity is encounter-specific; a stream's arithmetic lives here.
 * Preserve the historical zero-seed fallback and exact IEEE-754 output for
 * deterministic replay of previously recorded RS3 state snapshots.
 */
export interface SerializableRandomStream {
  (): number;
  getState(): number;
  setState(value: number): void;
}

export function seededXorshift32(seed: number): SerializableRandomStream {
  if (!Number.isInteger(seed) || seed < -0x80000000 || seed > 0xffffffff) {
    throw new RangeError(`Invalid RNG seed: ${seed}`);
  }
  let state = seed >>> 0 || 0x9e3779b9;
  const next = (() => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  }) as SerializableRandomStream;
  next.getState = () => state >>> 0;
  next.setState = value => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Invalid RNG state: ${value}`);
    }
    state = value;
  };
  return next;
}
