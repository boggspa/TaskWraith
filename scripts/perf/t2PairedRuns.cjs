'use strict'

/**
 * Wall 2 — T2 paired runs (Independent Threads Programme, G-X pairing).
 *
 * Windowed replay observes one fixture's lanes once, so a dual-run T2
 * descriptor is always light-beside (or light-alone for a solo fixture) and
 * the runner cannot emit `report.pairs`. `pairRuns` / `validateInterferenceReport`
 * already exist and the lanes driver already runs light-only vs light+heavy;
 * this module is the narrow adapter between them: one fixture, two lane
 * configurations, one pairRuns call, no new runner.
 *
 * Honesty rules, all pinned by `t2PairedRuns.test.ts`:
 *
 * - Alone is the light lane only; beside is the full lane set. Both runs
 *   share seed, workload, fixture fingerprint/versions, build, window and
 *   API options. The declared cell describes beside; alone uses its derived
 *   small/1 cell. The adapter never invents a second fixture.
 * - Driver outcomes pass through verbatim. Short windows, failed saves,
 *   missing identity and diagnostic-only runs keep pairing ineligible; the
 *   adapter never reshapes coverage or manufactures deltas.
 * - A single-chat fixture is refused at build time — there is no heavy
 *   population to stand beside. An operator-declared pairingRole is refused
 *   because this adapter produces both roles.
 */

const { runConcurrentReplayLanes } = require('./concurrentReplayLanes.cjs')
const { FIXTURE_GENERATOR_VERSION } = require('./fixtureGenerator.cjs')
const { cellName, parseCellName, lightAloneCellFor, pairRuns } = require('./interferenceMatrix.cjs')
const { buildT2LaneSpecs } = require('./t2WindowOrchestration.cjs')
const { createReplayRevisionState } = require('./replayRevisionState.cjs')

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function runT2PairedReplay(options) {
  if (!isPlainObject(options)) throw new Error('t2PairedRuns options required')
  const lanes = buildT2LaneSpecs(options.fixture)
  if (!lanes.some((lane) => lane.role === 'heavy')) {
    throw new Error('t2PairedRuns requires a heavy lane; a single-chat fixture cannot pair')
  }
  if (options.pairingRole !== undefined) {
    throw new Error(
      't2PairedRuns refuses pairingRole; it produces both light-alone and light-beside'
    )
  }
  const { fixture: _fixture, fixtureVersions, cell, cellName: declaredCellName, ...rest } = options
  // Match the lanes driver's cell-object precedence, then keep each role's
  // cell explicit. Missing or invalid names remain ineligible; they cannot
  // supply an identity from which to derive a baseline.
  const besideCellName = cell ? cellName(cell) : declaredCellName
  const besideCell = parseCellName(besideCellName)
  const aloneCellName = besideCell === null ? besideCellName : lightAloneCellFor(besideCell).name
  const shared = {
    ...rest,
    replayRevisionState: createReplayRevisionState(options.api),
    fixtureVersions: fixtureVersions ?? { fixtureGenerator: FIXTURE_GENERATOR_VERSION }
  }
  const lightLanes = lanes.filter((lane) => lane.role === 'light')
  const alone = await runConcurrentReplayLanes({
    ...shared,
    cellName: aloneCellName,
    lanes: lightLanes
  })
  const beside = await runConcurrentReplayLanes({ ...shared, cellName: besideCellName, lanes })
  return { alone, beside, pairing: pairRuns(alone.run, beside.run) }
}

module.exports = {
  runT2PairedReplay
}
