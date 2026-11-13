/**
 * Sourced accessory cast effects, shared between the Equilibrium runtime and
 * an external encounter adapter. No RNG is consumed here; the caller supplies
 * a sampled boolean at the committed cast, never in a legality preview.
 *
 * https://runescape.wiki/w/Occultist%27s_ring
 */
export const OCCULTISTS_RING_ID = "item:occultists-ring";
export const OCCULTIST_INFLICTION_CHANCE = 0.1;
export const OCCULTIST_INFLICTION_NECROSIS = 2;
export const OCCULTIST_NECROSIS_CAP = 12;

export interface EquippedAccessoryInputs {
  readonly equipmentIds?: readonly string[];
  readonly equipmentSlots?: Readonly<Partial<Record<string, string | null>>>;
}

export function isOccultistsRingEquipped(equipment: EquippedAccessoryInputs): boolean {
  return equipment.equipmentSlots?.ring === OCCULTISTS_RING_ID ||
    equipment.equipmentIds?.includes(OCCULTISTS_RING_ID) === true;
}

export interface OccultistCastShape {
  readonly id: string;
  readonly style: string;
  readonly hits: readonly { readonly band: { readonly maxPct: number } }[];
}

/**
 * One roll per damaging player Necromancy cast, never per hit/DoT tail/conjure.
 * Finger of Death and Death Grasp are eligible (refund arrives after spend).
 * Non-damaging abilities, summons and conjure commands cannot activate.
 */
export function occultistEligibleCast(ability: OccultistCastShape): boolean {
  return ability.style === "necromancy" &&
    !ability.id.startsWith("conjure_") &&
    !ability.id.startsWith("command_") &&
    ability.hits.some(hit => hit.band.maxPct > 0);
}

export interface OccultistInflictionResult {
  readonly necrosisStacks: number;
  readonly gained: number;
  readonly activated: boolean;
}

export function resolveOccultistInfliction(args: {
  readonly equipped: boolean;
  readonly eligible: boolean;
  readonly activated: boolean;
  /** State AFTER this ability has spent/generated its ordinary Necrosis. */
  readonly necrosisStacks: number;
  readonly cap?: number;
}): OccultistInflictionResult {
  const cap = args.cap ?? OCCULTIST_NECROSIS_CAP;
  if (!Number.isInteger(cap) || cap <= 0 ||
      !Number.isInteger(args.necrosisStacks) ||
      args.necrosisStacks < 0 || args.necrosisStacks > cap) {
    throw new RangeError("Invalid Necrosis resource state");
  }
  if (!args.equipped || !args.eligible || !args.activated) {
    return { necrosisStacks: args.necrosisStacks, gained: 0, activated: false };
  }
  const next = Math.min(cap, args.necrosisStacks + OCCULTIST_INFLICTION_NECROSIS);
  return { necrosisStacks: next, gained: next - args.necrosisStacks, activated: true };
}
