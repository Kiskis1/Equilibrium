# Combat engine

Simulation semantics: when combat events happen, what state survives between them, and the layout of `src/combat/engine/`. Hit formulas live in [`combat-model.md`](./combat-model.md). Equipment activation and routing live in [`equipment-effects.md`](./equipment-effects.md).

This document describes **target semantics**. Fix code to match the rules; do not weaken the rules to preserve a defect.

## Architecture

```text
src/combat/engine/
  cast/          atomic cast transition
    effects/     cast-start state changes (lifecycle stage, then style)
  runtime/       clock, per-run mutable runtime, event queue, RotationState
  resolution/    land-time damage calculation
    landed/      on-hit state transitions by style
  simulation/    fixed-lane drivers, contracts, summaries
  schedulers/    autonomous actors (conjures)
```

### Boundaries

| Rule                                    | Detail                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparation is read-only                | `cast/prepare.ts` computes against advanced state and records mutations as `PreparedTransition` variants. New mechanics add variants, not booleans on `PreparedCast`.                                                                 |
| Rejected cast is inert                  | No resources, cooldowns, scheduled events, or cast records beyond the time advance used to re-check readiness.                                                                                                                        |
| Single readiness boundary               | `prepareSimulationCast` decides readiness/affordability for manual and Revolution lanes.                                                                                                                                              |
| Effects split by lifecycle and style    | `cast/effects/`: prepared transitions, cooldowns, resources, completion, plus one module per style. Channel completion effects run after occupancy advance (`completion.ts`).                                                         |
| Resolution calculates; recording writes | Resolvers return `EventResolution` and do not touch ledgers. `resolution/record.ts` writes totals, per-ability ledgers, hit details, event log, then dispatches `accounting`, league blessing damage, invention procs, and `landed/`. |
| Landed handlers for real hits only      | Attached components, conjure autos, poison ticks, and procs are excluded by the caller.                                                                                                                                               |
| State grouped by style and target       | Global clocks on `RotationState`; style buckets and `target` for debuffs the sim applied.                                                                                                                                             |
| Immutable patches only                  | `patchMelee`, `patchRanged`, `patchMagic`, `patchNecro`, `patchConjures`, `patchTarget` - no in-place nested mutation.                                                                                                                 |
| Conjures are capability-typed           | `ActiveConjure` carries only the tracks that spirit has. Sentinel shared shapes are forbidden.                                                                                                                                        |
| DoT classification is declared          | `AbilityHit.dot` + scheduler; not inferred from land tick or crit eligibility.                                                                                                                                                        |
| External API is the barrel              | `src/combat/index.ts`. `cast/`, `resolution/`, `runtime/`, `schedulers/` stay internal.                                                                                                                                               |

No arbitrary callback plumbing for hidden state. No compatibility shims that accept retired shapes.

### Solver orchestration (`src/combat/solver/`)

| Module                 | Ownership                                        |
| ---------------------- | ------------------------------------------------ |
| `solveFromRequest.ts`  | Public entry: wire request → search → DTO        |
| `requestContext.ts`    | Deny lists, pools, seeds, horizons, budgets      |
| `evaluationSession.ts` | Memoized bar evaluation and session counters     |
| `progressReporter.ts`  | Phase mapping and progress emission              |
| `resultBuilder.ts`     | Winner validation and `SolverResultDTO` assembly |

Deterministic benches: `npm run benchmark:solver:quick` (see [`solver-benchmarks.md`](./solver-benchmarks.md)). Combat-domain → UI imports are gated by `npm run audit:architecture`.

## Runtime and state ownership

### `RotationState` (`engine/runtime/state.ts`)

Complete simulation state. Never hide combat state in module globals, UI, or undocumented closures.

**Global fields**

- `tick` — next tick the actor may begin another cast (GCD encoded here)
- `adrenaline` / `adrenalineCap`
- `cooldowns` — ability id → first ready tick
- `relentlessUntilTick`, `naturalInstinctUntilTick`, `vestmentsAdrenalineUntilTick`
- `invention` — Crackling / Aftershock clocks and charge
- optional `league` clocks (e.g. Avernic Rampage, Striking Light)

**Style buckets:** `melee`, `ranged`, `magic`, `necromancy` (constructed in their style modules).

**Target:** `lastAttackTick`, burns, Bloat owner cast, melee target effects. Debuffs the sim applied to the target live here, not on the player.

Timed windows are half-open unless a sourced mechanic says otherwise: active while `currentTick < untilTick`, inactive at `untilTick`.

### `SimulationRuntime`

Per-run bookkeeping created once and threaded through: event queue, ledgers (`totalExpected` / support bounds / `perAbility` / `damageByTick`), cast and event logs, sequence counters, analysis state. Never a module-level singleton (concurrent runs must not interfere).

### Starting state

Starting adrenaline, stacks, cooldowns, and windows are **configurable**. Metrics used to compare rotations/gear/rulesets must report the opening conditions used. Defaults stay explicit in contracts (`SimulateInput.startingAdrenaline`, etc.).

## Canonical tick advancement

Time advances only through `advanceTo(rt, targetTick)` (`engine/runtime/clock.ts`):

1. Process scheduled events due by the bound in **(tick, seq)** order.
2. Apply passive resource generation over the crossed interval (e.g. Meteor Strike, Vestments regen).
3. Expire clocks at defined boundaries (e.g. Berserk end).
4. Stop with state representing the **target tick** before affordability checks finalize.

Horizon runs land events only while `tick < horizon` (half-open). Do not inspect a future cast against stale pre-advance resources. Manual, Revolution, Quick estimates, conjures, and league effects share this clock — no partial alternate advancement paths.

## Atomic cast transition

Canonical order:

1. Earliest candidate tick from GCD / occupancy and ability cooldowns (`firstLegalTick`).
2. `advanceTo` that tick.
3. Re-check requirements, target conditions, affordability on advanced state.
4. Resolve empowered variant and consume resources in the same transition.
5. Start cooldown and cast occupancy.
6. Schedule hits, channels, DoTs, and delayed effects **with provenance**.
7. Apply immediate on-cast grants/windows in sourced order.

Rejected casts leave no partial mutations. After a spender drains a capped resource, the next spender stays unempowered until rebuild. Style resources (Bloodlust, Deathspore, Necrosis, Residual Souls, Runic Charge, ammo, league state) use their helpers — not special cases in the outer rotation loop.

### Cast occupancy vs GCD vs channel

Separate concepts. Channelled abilities declare:

- total channel / occupancy duration (`channelTicks` = last hit offset + 1)
- hit offsets within that duration
- cancellation rules (manual and Revolution **complete** channels by default; cancellation only with an explicit cancellation point, then later channel events removed or marked cancelled)

Never award a full channel while advancing the actor by only one GCD. Hits scheduled past the reporting horizon do not count as landed damage merely because the cast began inside the horizon.

## Events and provenance

Every damaging or state-changing event (`ScheduledEvent` in `engine/runtime/events.ts`) carries:

- source cast or scheduler (`sourceCast`, `abilityId`)
- family: `hit | dot | proc | blessing | conjureAuto | command | poison`
- hit index, land tick, monotonic `seq` (same-tick order is `(tick, seq)`)
- `attached` vs separate hit; `procEligible`; `recursionAllowed`
- **required** `DamageProvenance` (`kind` + optional `detail`) - product gates via `capabilitiesOf(provenance)`, not ability-id lists
- analysis `originKind`; multiplicity (`expectedTriggerRolls` / `expectedActivations` / `expectedSeparateHits`); optional `damageTag`
- optional `derivedFrom`, DoT metadata, cancel owner
- `castSnap` - cast-scoped snapshot for land-time resolve (required on cast-scheduled `resolveCastHit` events)
- `lightningSurge?: boolean` - marker on magic crit-eligible hits; snap is `castSnap`, not a nested object
- `resolve(rt, landTick)` - **land-time** calculation against current state (Sunshine / Berserk / Searing Winds at land, not cast)

### Schedule path

- Cast hits go through `enqueueEvent` / `scheduleEvent`, both `assertProvenance` before queue push.
- `scheduleCastEvents` always sets `castSnap` on cast-scheduled hits; magic non-DoT crit-eligible hits also set `lightningSurge: true`.
- Landed Lightning Surge reads `event.castSnap` (marker alone is not enough).

### Capability rules of note

- Gates are provenance kind + `capabilitiesOf`, not ability-id lists.
- Blessing isolation is provenance kind `blessing` (`canTriggerProcs: false`, no on-hit gear). `blessingGenerated` remains only in `provenanceFromLegacy` migration; not on `CombatContext`.
- Crackling eligibility follows the family + `canTriggerProcs` gate. Aftershock charge also includes conjured spirit auto/poison damage even when those sources cannot trigger Crackling; Invention blasts and equipment procs never recursively charge. The shared `inventionRuntime.ts` transition accepts either a tagged statistical summary or a settled integer, and returns serializable state and proc descriptors.
- `canApplyAbyssalParasite` is true only for `player_direct` / `player_auto`. Stack application is land-time (capabilities + melee + passive + damage).
- Endless Assault converted channel hits use `player_converted_channel` (DoT-family gear gates; prayer/window mods + crit retained).

Events must not close over a runtime instance; each lane resolves them against its own state.

### Hit-count integrity

One real proc-eligible hit = one hit event with `attached: false` and `procEligible: true` as appropriate. Attached damage on an existing hit does **not** inflate:

- on-hit proc rolls
- stack generation
- adrenaline generation
- hit counters
- effect extension counts

Separate-hit mechanics are separate events with explicit crit, cap, target-modifier, recursion, and proc-eligibility rules. Derived events inherit crit/source properties only when the mechanic says so.

### Next-hit effects

Consumed by the first eligible **landed** hit, not applied to the whole ability before per-hit resolution. Multi-hit, channels, bounces, and DoT evaluate eligibility at event scope.

## RNG policy

Do not flatten all randomness into expected damage.

| Kind                                                                                                         | Treatment                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Damage-only randomness (does not change future state, topology, or cast legality)                            | Deterministic expected value   |
| State-changing RNG (adrenaline, cooldowns, windows, stacks, scheduled events, target state, future legality) | One concrete outcome per deterministic stratified lane |

Current cast RNG points include `impatient`, `relentless`, and `avernic-rampage`. Icy Tempest and Tsunami crit-adrenaline also sample coupled future state.

Player poison uses one concrete target state per lane. That state stores active tier, expiry, cadence, remaining hits, decay index, earned delayed-hit carriers, Cinderbane continuation, source multiplier, and Envenomed immunity. Application and continuation are sampled because they change future target state; poison damage-range randomness stays expected-value. One provenance capability decides eligibility per hitsplat: player attacks, player DoTs, and verified separate player auxiliary/blessing hits are eligible; attached riders, familiar/conjure damage, Putrid Zombie pulses, and Blood Reaver passive damage are not. Analysis attributes lane-weighted poison hits back to the eligible source row.

Big Boned and Abyssal Cinders are host-attached damage terms. Each term creates no extra hit or proc roll and cannot recursively attach itself. Cinders resolves inside the host modifier pipeline. Big Boned applies to every supported host, including poison, but its 5% maximum-life amount is added after host source, target, poison, and Damage Potential modifiers; it inherits the parent critical result and shares the final hit cap. Cinders retains its narrower eligibility matrix and does not apply to poison or to another attached term. Inferno remains a separate blessing hit; it can host Big Boned but not Cinders and cannot start an unbounded blessing event chain. Splash Zone uses `targetSize` for its size bonus; `occupiedTiles` remains separate spatial-coverage input for mechanics that use footprint area.

### Fixed stochastic lanes

- Manual and Revolution simulations automatically use one lane when no supported RNG can change later state, otherwise the same 128 deterministic stratified lanes.
- Each lane owns one `SimulationRuntime` and one concrete `RotationState`.
- Named counter-based streams make repeated inputs bit-for-bit deterministic and keep mechanics from sharing accidental RNG order.
- Stateful-RNG runs use a fixed lane count and seed in the production UI and solver. There is no adaptive retry ladder.
- Lane weights always sum to one. Fixed-window results report probability mass 1 and residual mass 0; no lane is discarded or survivor-renormalized.
- The model is an estimate for future-changing RNG. Damage-only randomness remains exact expected value where the damage pipeline supports it.
- `createCastContext` is a one-lane diagnostic. Use `simulate` or `simulateRevolution` for stochastic expectations.

#### Accuracy contract

| Quantity | Treatment | Accuracy impact |
| --- | --- | --- |
| Damage bands, crit chance, and damage-only procs | Closed-form or pipeline expected value | No sampling error; normal formula and rounding assumptions still apply. |
| Impatient, Relentless, Avernic Rampage, Icy Tempest spend, Tsunami crit-adrenaline | Concrete outcome in each of 128 lanes | Deterministic estimate. An isolated Bernoulli rate is quantized to one lane (1/128); interacting rolls can accumulate more error. |
| Poison application, Cinderbane continuation, and occurrence-gated poison state | Concrete target state in each lane; compact binomial/geometric sampling where an event represents repeated occurrences | Rare continuation counts have visible sampling noise. The combined Avernic/Cinderbane workload is pinned within 1% of the retired exact oracle in `stochasticMigration.test.ts`. |
| Aggregate damage and analysis counts | Equal-weight mean across all lanes | Unit-mass estimate with no discarded outcomes. |
| `totalMin` / `totalMax` | Lowest/highest conditional damage band observed across lanes | Bounds the sampled ensemble, not every mathematically possible future-state history. |
| `casts` / `events` | Most common concrete history | For explanation only; it is not a fractional expected timeline and does not rebuild aggregate totals. |

The fixed seed makes regression results repeatable; it is not a confidence interval. Increasing lanes is a product-model change, not a retry response to one run.

Do not restore the retired global state enumerator, future-state keys, event signatures, live-state caps, residual-mass pruning, adaptive reruns, poison atom distributions, poison future profiles, or poison transition interners. `residualWeight` remains only as a zero-valued invariant on fixed-lane summaries.

### Analysis count semantics

Every count in `analysis.byEffect` is a lane-weighted expected value: `expectedCasts`, `expectedTriggerRolls`, `expectedActivations`, `expectedSeparateHits`, and `expectedAttachedComponents`. Values may be fractional after lane aggregation or deterministic expected-value packing.

`summary.casts` and `summary.events` are concrete arrays from the complete history or one representative terminal class. Their array lengths are integers and must not be used to reconstruct or reconcile the weighted analysis ledger when `history.eventsReconcileWithWeightedTotals` is false.

## Resource clocks and lockouts

A timed resource owns its full lifecycle in one place (stacks/charges, free-cast window, rebuild lockout, expiration tick, provenance). Clocks are checked **after** canonical advancement. Spend/conversion/lockout start are atomic. Stack generation during a sourced lockout is rejected by the state helper.

## Sequences and target-dependent mechanics

Enable chains are explicit state machines (stage, granting event/cast, expiration). A follow-up without a live predecessor is rejected or skipped by rotation mode — never silently legal.

Mechanics that need target HP%, weakness, size, poisonability, etc. require that input. When missing, mark **partially modeled** / **not modeled** — do not invent defaults (e.g. `targetHpPercent` on `SimulateInput`).

## Conjure and auxiliary schedulers

Conjures and similar autonomous actors share the event queue but own scheduler state (`engine/schedulers/`). Commands that pause/replace/delay/reset a schedule mutate that scheduler. Command and auto schedules do not run concurrently unless the sourced mechanic allows it.

Global combat modifiers stay separate from cast-specific modifiers; event provenance decides applicability.

## Horizon and metrics

**Canonical DPS: landed damage within the horizon.**

- Process casts, channel hits, DoTs, procs, conjure events, delayed tails only through `horizonTicks`.
- Do not drain remaining conjure/channel/DoT lifetime after the horizon.
- Divide only damage that landed in the interval by that interval.

Optional second metric: **damage from casts begun within the horizon** including later tails — only when explicitly requested (`includeTails` / `totalExpectedIncludingTails`), separately named, never presented as fixed-window DPS.

**Detail levels** (`SimulateOptions.detailLevel`, default `full-analysis`):

- `score-only` - ranking metrics only (`totalExpected`, `damageByTick`, rng gates). Solver search + finalize ranking use this; winner presentation re-sims at full-analysis.
- `summary` - score metrics plus light diagnostics; no casts/events/analysis.
- `full-analysis` - full `RotationSummary` for UI/forensics.

Physics, stochastic streams, and ranking metrics are identical across detail levels (`scoreOnlyParity.test.ts`).

| Metric                 | Definition                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fixed-window DPM       | Everything that lands inside a stated window ÷ window. Unfinished tails past the edge excluded. Denominator is an input. |
| Natural-completion DPM | Rotation run to its own end including every scheduled tail ÷ actual elapsed. Denominator is an output.                   |

Never compare one against the other unlabeled. Report which metric and its window or elapsed ticks.

## League effect routing

Nothing league-specific is baked into base formulas or unconditional simulator state. With ruleset `"base"` and no league loadout, base-game output, event order, and cast sequence are unchanged.

| Effect shape                                            | Entry point                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Derived inputs / resolver overrides                     | Shared combat or loadout context via `resolveLeagueRules`       |
| Per-hit / per-attack blessing damage                    | Event + provenance (`resolution/league/`, `family: "blessing"`) |
| Adrenaline, cooldowns, windows, stacks, future legality | Simulation state (`RotationState.league`, etc.)                 |
| Outside outgoing-damage sim                             | Displayed, excluded from totals                                 |

Support labels match the honesty model in [`combat-model.md`](./combat-model.md) (`modeled` / `partially modeled` / `not modeled` / `mechanics unverified` as exposed to users).

## Drivers and contracts

- **Manual rotation** - `simulation/simulate.ts`: queued `RotationAction[]`, optional automatic Basic Attacks, fixed-lane sampling for state-changing RNG. The combat UI supplies a 100-tick fixed window so Cinderbane continuation is bounded and directly comparable with a 60-second Revolution bar; engine callers may still request natural completion by omitting `horizonTicks`.
- **Revolution** — `simulation/revolution.ts`: bar-driven selection; shares prepare/commit and clock.
- **Contracts** — `simulation/contracts.ts` (`SimulateInput`, adrenaline/proc rules, equipment effects, league rules, horizon options).

Ability/equipment data own sourced durations, stack thresholds, hit offsets, and cooldowns. The engine owns scheduling and state interaction of those values.

## Testing expectations (simulation)

Focused **state and event** assertions, not only aggregate DPS.

Cover where relevant:

- GCD vs longer cast occupancy
- Channel completion and explicit cancellation
- Single-hit, multi-hit, bounce, DoT
- First-hit vs per-hit consumption
- Attached damage vs separate hit
- Resource generation exactly at the ready tick
- Stack spend, expiry, rebuild, lockout boundaries
- Sequence success, missing predecessor, expiration
- Simultaneous events with deterministic ordering
- State-neutral EV vs state-changing sampled lanes
- Autonomous scheduler + command interaction
- Events landing before / at / after the horizon
- Ruleset `"base"` vs `"equilibrium"`
- Unsupported or provisional mechanics excluded or labeled

Base-ruleset fixtures must remain identical when league modifiers are absent.

Never retarget a snapshot or golden total without a source for the mechanic that moved. Prefer event/state assertions over aggregates when diagnosing regressions.

## Related

- [`combat-model.md`](./combat-model.md) — formulas, pipeline, caps, sources
- [`equipment-effects.md`](./equipment-effects.md) — passives, sets, procs routing
  )
