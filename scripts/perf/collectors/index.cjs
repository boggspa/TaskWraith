'use strict'

/**
 * Barrel export for T1b collectors. No launch / attach side effects.
 */

const cdpRendererCollector = require('./cdpRendererCollector.cjs')
const nodeInspectorMainCollector = require('./nodeInspectorMainCollector.cjs')
const osProcessSampler = require('./osProcessSampler.cjs')
const eventIngestion = require('./eventIngestion.cjs')
const perfProbeJsonl = require('./perfProbeJsonl.cjs')
const mainPersistenceStatsCollector = require('./mainPersistenceStatsCollector.cjs')

module.exports = {
  ...cdpRendererCollector,
  ...nodeInspectorMainCollector,
  ...osProcessSampler,
  ...eventIngestion,
  ...perfProbeJsonl,
  ...mainPersistenceStatsCollector
}
