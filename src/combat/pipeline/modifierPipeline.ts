import { recordModifierProgramEvaluation, recordModifierSort } from "../profiling/hitPipeline";
import { floorDamage, mulFloor } from "../core/rounding";
import type { CombatContext, CombatModifier, DamageState, ModifierStage } from "../types";

/** Explicit stage order - the pipeline is deterministic, never one combined formula. */
export const STAGE_ORDER: readonly ModifierStage[] = [
  "base",
  "ability",
  "onCast",
  "roll",
  "critical",
  "onHit",
  "target",
  "postHit",
];

export function orderModifiers(modifiers: readonly CombatModifier[]): CombatModifier[] {
  recordModifierSort();
  return [...modifiers].sort(compareModifierOrder);
}

const compareModifierOrder = (a: CombatModifier, b: CombatModifier) =>
  STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.priority - b.priority;

/**
 * Apply an already-ordered modifier list (no sort).
 * When `preFiltered` is true, skips `applies` checks; only valid when the list was
 * filtered against the same stable context used for every roll in a hit band.
 */
export function runOrderedPipeline(
  initial: DamageState,
  orderedModifiers: readonly CombatModifier[],
  context: CombatContext,
  preFiltered = false,
  criticalDamageMultiplier?: number,
  criticalRounding?: "rs3-host",
): DamageState {
  const active = preFiltered
    ? orderedModifiers
    : orderedModifiers.filter((m) => m.applies(context));
  const hasCriticalDamage = criticalDamageMultiplier != null;
  recordModifierProgramEvaluation(active.length + (hasCriticalDamage ? 1 : 0));
  let state = initial;
  let criticalDamageApplied = false;
  for (const m of active) {
    if (
      hasCriticalDamage &&
      !criticalDamageApplied &&
      (STAGE_ORDER.indexOf(m.stage) > STAGE_ORDER.indexOf("critical") ||
        (m.stage === "critical" && m.priority > 0))
    ) {
      state = { damage: criticalRounding === "rs3-host"
        ? floorDamage(state.damage * criticalDamageMultiplier!)
        : mulFloor(state.damage, criticalDamageMultiplier!) };
      criticalDamageApplied = true;
    }
    state = m.apply(state, context);
  }
  if (hasCriticalDamage && !criticalDamageApplied) {
    state = { damage: criticalRounding === "rs3-host"
      ? floorDamage(state.damage * criticalDamageMultiplier!)
      : mulFloor(state.damage, criticalDamageMultiplier!) };
  }
  return state;
}

/** Sort once, then filter for a stable context. Safe to reuse across all rolls in a band. */
export function compileActiveModifiers(
  modifiers: readonly CombatModifier[],
  context: CombatContext,
): CombatModifier[] {
  return orderModifiers(modifiers).filter((m) => m.applies(context));
}

export function applyAbilityBaseModifiers(
  base: number,
  modifiers: readonly CombatModifier[],
  context: CombatContext,
): { base: number; modifiers: CombatModifier[] } {
  let resolvedBase = base;
  const remaining: CombatModifier[] = [];
  for (const modifier of [...modifiers].sort(compareModifierOrder)) {
    if (modifier.abilityBaseMultiplier === undefined) {
      remaining.push(modifier);
      continue;
    }
    if (modifier.applies(context)) {
      resolvedBase = mulFloor(resolvedBase, modifier.abilityBaseMultiplier);
    }
  }
  return { base: resolvedBase, modifiers: remaining };
}

export function runPipeline(
  initial: DamageState,
  modifiers: readonly CombatModifier[],
  context: CombatContext,
): DamageState {
  return runOrderedPipeline(initial, orderModifiers(modifiers), context, false);
}
