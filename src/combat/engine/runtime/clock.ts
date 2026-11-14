import { endBerserk } from "../../styles/melee/bloodlust";
import { METEOR_STRIKE_PASSIVE_ADREN_PER_TICK } from "../../styles/melee/effects";
import { processSpiritEvent } from "../schedulers/conjures";
import { recordResolved } from "../resolution";
import { gainAdrenaline, patchMagic, patchMelee, patchRanged } from "./state";
import type { SimulationRuntime } from "./runtime";
import { playerPoisonPrecedes } from "../schedulers/playerPoison";
import {
  nextPlayerPoisonEvent,
  processNextPlayerPoisonEvent,
} from "../schedulers/playerPoisonState";
import { applyPoisonLandEffects } from "../simulation/poisonLand";
import { temperedHeartAdrenalineGain } from "../../league/ruleset";
import { clockAdvanceBounds } from "./clockBounds";
import { applyStatefulLandRng } from "../simulation/statefulLand";
import { expirePrimordialIce } from "../../styles/melee/primordialIce";
import {
  advanceSongAdrenalineStream,
  normalizeEssenceCorruptionState,
  normalizeSongAdrenalineStream,
} from "../../styles/magic/songOfDestruction";
import { expireWenArrowState } from "../../styles/ranged/wen";
import {
  applyRevengeIncomingHit,
  nextRevengeIncomingHitTick,
  normalizeRevengeState,
} from "../../styles/shared/revenge";
import { patchDefence } from "./state";
import { normalizeSpellStacks } from "../../styles/magic/ancientSpells";
import { normalizeScriptureOfAmascutState } from "../../passives/scriptureOfAmascut";
import { patchScriptureOfAmascut } from "./state";

/**
 * The canonical simulation clock. Time moves only through advanceTo: it lands
 * every queued event due by the target tick in (tick, seq) order, applies
 * passive generation over the crossed interval, expires crossed clocks, and
 * stops with state representing exactly the target tick.
 */

function processDueEvents(rt: SimulationRuntime, bound: number): void {
  for (;;) {
    const event = rt.queue.peek();
    const poison = nextPlayerPoisonEvent(rt);
    const revengeTick = nextRevengeIncomingHitTick(rt.state.defence.revenge);
    if (
      revengeTick != null &&
      revengeTick <= bound &&
      (poison == null || revengeTick <= poison.tick) &&
      (event == null || revengeTick <= event.tick)
    ) {
      rt.state = patchDefence(rt.state, {
        revenge: applyRevengeIncomingHit(rt.state.defence.revenge, revengeTick),
      });
      continue;
    }
    if (playerPoisonPrecedes(poison, event)) {
      if (!poison || poison.tick > bound) return;
      processNextPlayerPoisonEvent(rt, bound);
      continue;
    }
    if (!event || event.tick > bound) return;
    rt.queue.shift();
    if (event.family === "conjureAuto" || event.family === "poison") {
      processSpiritEvent(rt, event);
      continue;
    }
    // Player meta (heals / expire / revive markers): resolve mutates player state;
    // still record for timeline, then skip damage side-effects.
    if (event.family === "player") {
      const resolution = event.resolve(rt, event.tick);
      recordResolved(rt, event, resolution);
      continue;
    }
    const resolution = event.resolve(rt, event.tick);
    const landed = recordResolved(rt, event, resolution);
    if (event.family === "status") continue;
    applyPoisonLandEffects(rt, event, resolution.damage);
    applyStatefulLandRng(rt, event, landed.damage);
  }
}

/** Meteor Strike passive adrenaline: constant per-tick rate while the window covers the tick. */
function grantMeteorPassive(
  rt: SimulationRuntime,
  fromTick: number,
  toTickExclusive: number,
): void {
  if (rt.state.melee.meteorStrikeUntilTick <= 0 || toTickExclusive <= fromTick) return;
  let gain = 0;
  const end = Math.min(toTickExclusive, rt.state.melee.meteorStrikeUntilTick);
  for (let t = fromTick; t < end; t++) gain += METEOR_STRIKE_PASSIVE_ADREN_PER_TICK;
  if (gain > 0) rt.state = gainAdrenaline(rt.state, gain);
}

/** Vestments Herald timed ledger: 0.5 adren/tick while window open (15 over 18s). */
function grantVestmentsPassive(
  rt: SimulationRuntime,
  fromTick: number,
  toTickExclusive: number,
): void {
  const end = Math.min(toTickExclusive, rt.state.vestmentsAdrenalineUntilTick);
  if (end > fromTick) {
    // VESTMENTS_REGEN_PER_TICK = 0.5; kept inline so clock stays free of equipment import cycles.
    rt.state = gainAdrenaline(rt.state, (end - fromTick) * 0.5);
  }
}

function grantTemperedHeart(
  rt: SimulationRuntime,
  fromTick: number,
  toTickInclusive: number,
): void {
  const gain = temperedHeartAdrenalineGain(rt.input.league, fromTick, toTickInclusive);
  if (gain > 0) rt.state = gainAdrenaline(rt.state, gain);
}

function grantSongAdrenaline(
  rt: SimulationRuntime,
  fromTick: number,
  toTickExclusive: number,
): void {
  const stream = rt.state.magic.song.adrenalineStream;
  if (rt.input.equipmentEffects?.songOfDestruction?.enabled !== true) {
    if (stream.remainingPulses > 0 || stream.nextPulseTick > 0) {
      rt.state = patchMagic(rt.state, {
        song: {
          ...rt.state.magic.song,
          adrenalineStream: { nextPulseTick: 0, remainingPulses: 0 },
        },
      });
    }
    return;
  }
  const result = advanceSongAdrenalineStream(stream, fromTick, toTickExclusive);
  if (
    result.stream.nextPulseTick !== stream.nextPulseTick ||
    result.stream.remainingPulses !== stream.remainingPulses
  ) {
    rt.state = patchMagic(rt.state, {
      song: { ...rt.state.magic.song, adrenalineStream: result.stream },
    });
  }
  if (result.pulses > 0) {
    rt.analysis.song.timedAdrenalineGained += result.pulses;
    rt.state = gainAdrenaline(rt.state, result.pulses);
  }
}

function normalizeSongClocks(rt: SimulationRuntime, tick: number): void {
  const current = rt.state.magic.song;
  const essenceCorruption = normalizeEssenceCorruptionState(current.essenceCorruption, tick);
  const conflagrateUntilTick =
    current.conflagrateUntilTick > 0 && current.conflagrateUntilTick <= tick
      ? 0
      : current.conflagrateUntilTick;
  const adrenalineStream =
    rt.input.equipmentEffects?.songOfDestruction?.enabled === true
      ? normalizeSongAdrenalineStream(current.adrenalineStream, tick)
      : { nextPulseTick: 0, remainingPulses: 0 };
  rt.analysis.song.finalStacks = essenceCorruption.stacks;
  if (
    essenceCorruption.stacks !== current.essenceCorruption.stacks ||
    essenceCorruption.expiresAtTick !== current.essenceCorruption.expiresAtTick ||
    conflagrateUntilTick !== current.conflagrateUntilTick ||
    adrenalineStream.nextPulseTick !== current.adrenalineStream.nextPulseTick ||
    adrenalineStream.remainingPulses !== current.adrenalineStream.remainingPulses
  ) {
    rt.state = patchMagic(rt.state, {
      song: {
        ...current,
        essenceCorruption,
        conflagrateUntilTick,
        adrenalineStream,
      },
    });
  }
}

/**
 * Resolve all events through the CURRENT tick without advancing the clock.
 * Used by the opt-in tick driver before casting and after scheduling hits at
 * that same tick. Damage/event ordering still belongs exclusively to this
 * Equilibrium clock; encounter-side event rules are not duplicated here.
 */
export function settleCurrentTick(rt: SimulationRuntime): void {
  const bound = rt.horizon === undefined
    ? rt.state.tick
    : Math.min(rt.state.tick, rt.horizon - 1);
  processDueEvents(rt, bound);
}

/**
 * By default the original clock includes events at targetTick. The stepped
 * driver can defer only that boundary's events until the following tick.
 * The default is deliberately unchanged for every existing simulation.
 */
export function advanceTo(
  rt: SimulationRuntime,
  targetTick: number,
  options?: { deferTargetEvents?: boolean },
): void {
  if (targetTick < rt.state.tick) return;
  const bounds = clockAdvanceBounds(targetTick, rt.horizon);
  // A horizon run never lands events at or after the horizon (half-open).
  processDueEvents(rt, options?.deferTargetEvents
    ? Math.min(bounds.eventEndInclusive, targetTick - 1)
    : bounds.eventEndInclusive);
  grantMeteorPassive(rt, rt.state.tick, bounds.perTickEndExclusive);
  grantVestmentsPassive(rt, rt.state.tick, bounds.perTickEndExclusive);
  grantSongAdrenaline(rt, rt.state.tick, bounds.perTickEndExclusive);
  grantTemperedHeart(rt, rt.state.tick, bounds.eventEndInclusive);
  if (rt.state.melee.bloodlust.berserk && targetTick >= rt.state.melee.berserkUntilTick) {
    rt.state = patchMelee(rt.state, {
      bloodlust: endBerserk(rt.state.melee.bloodlust),
      berserkUntilTick: 0,
    });
  }
  if (targetTick > rt.state.tick) rt.state = { ...rt.state, tick: targetTick };
  normalizeSongClocks(rt, rt.state.tick);
  const bloodTithe = normalizeSpellStacks(rt.state.magic.bloodTithe, rt.state.tick);
  const glacialEmbrace = normalizeSpellStacks(rt.state.magic.glacialEmbrace, rt.state.tick);
  const frostSurgeReadyTick =
    rt.state.magic.frostSurgeReadyTick > 0 && rt.state.magic.frostSurgeReadyTick <= rt.state.tick
      ? 0
      : rt.state.magic.frostSurgeReadyTick;
  if (
    bloodTithe !== rt.state.magic.bloodTithe ||
    glacialEmbrace !== rt.state.magic.glacialEmbrace ||
    frostSurgeReadyTick !== rt.state.magic.frostSurgeReadyTick
  ) {
    rt.state = patchMagic(rt.state, { bloodTithe, glacialEmbrace, frostSurgeReadyTick });
  }
  const ice = expirePrimordialIce(rt.state.melee.primordialIce, rt.state.tick);
  if (ice !== rt.state.melee.primordialIce) {
    rt.state = patchMelee(rt.state, { primordialIce: ice });
  }
  const wen = expireWenArrowState(rt.state.ranged.wen, rt.state.tick);
  if (wen !== rt.state.ranged.wen) rt.state = patchRanged(rt.state, { wen });
  const revenge = normalizeRevengeState(rt.state.defence.revenge, rt.state.tick);
  if (revenge !== rt.state.defence.revenge) {
    rt.state = patchDefence(rt.state, { revenge });
  }
  const scriptureOfAmascut = normalizeScriptureOfAmascutState(
    rt.state.scriptureOfAmascut,
    rt.state.tick,
  );
  if (scriptureOfAmascut !== rt.state.scriptureOfAmascut) {
    rt.state = patchScriptureOfAmascut(rt.state, scriptureOfAmascut);
  }
}
