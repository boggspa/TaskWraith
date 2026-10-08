#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const filters = process.argv.slice(2)
const result = spawnSync(
  process.execPath,
  [
    path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run',
    ...(filters.length ? filters : ['scripts/studio-', 'src/main/studio/'])
  ],
  { stdio: 'inherit', env: { ...process.env, TASKWRAITH_INCLUDE_STUDIO: '1' } }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
