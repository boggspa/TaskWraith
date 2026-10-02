'use strict'

const path = require('node:path')
const { resolveRolloutFlags } = require('./rolloutFlags.cjs')

/** CLI argv only; launch ownership and complete X evidence are not fabricated. */
function buildM5FlagPairPlan({
  repoRoot,
  homeRoot,
  artifactRoot,
  gitSha,
  cell,
  seed = 42,
  flags = []
}) {
  if (![repoRoot, homeRoot, artifactRoot].every((p) => typeof p === 'string' && path.isAbsolute(p)))
    throw new Error('absolute roots required')
  if (!/^[a-f0-9]{40}$/.test(gitSha || '')) throw new Error('exact source SHA required')
  resolveRolloutFlags({ declared: flags })
  const captures = Array.from({ length: 6 }, (_, index) => {
    const state = index % 2 ? 'on' : 'off'
    const repetition = Math.floor(index / 2)
    const id = `x6-${state}-${repetition}`
    const declared = state === 'on' ? flags : []
    return {
      state,
      repetition,
      rolloutFlags: resolveRolloutFlags({ declared }).record,
      argv: [
        '--workload=light_beside_large_live',
        '--live-lanes',
        '--live-repetitions=1',
        `--live-repetition-index=${repetition}`,
        '--launch',
        '--i-accept-isolated-launch',
        '--materialize-instance-userdata',
        `--home=${path.join(homeRoot, id)}`,
        `--artifact-dir=${path.join(artifactRoot, id)}`,
        `--out-dir=${path.join(artifactRoot, id)}`,
        `--instance-id=${id}`,
        `--git-sha=${gitSha}`,
        `--build-id=${gitSha}`,
        `--cell=${cell}`,
        `--seed=${seed}`,
        '--port=9420',
        '--inspect-port=9820',
        ...declared.map((flag) => `--flag=${flag}`)
      ]
    }
  })
  return {
    captures,
    runner: path.join(repoRoot, 'scripts/perf/runT2Baseline.cjs'),
    diagnosticOnly: true,
    executableQualification: false,
    missingEvidence: [
      'X2 gap attribution',
      'complete X3 counters',
      'I7 complete flag qualification'
    ],
    note: 'One measured window per invocation in ABAB order; qualify only with complete bound evidence.'
  }
}

module.exports = { buildM5FlagPairPlan }
