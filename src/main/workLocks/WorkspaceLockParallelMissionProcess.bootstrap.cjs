'use strict'

const path = require('node:path')
const jiti = require('jiti')(
  path.join(__dirname, 'WorkspaceLockParallelMissionProcess.bootstrap.cjs')
)
const workerModule = process.env.TASKWRAITH_PROCESS_WORKER_MODULE

if (!workerModule) {
  throw new Error('TASKWRAITH_PROCESS_WORKER_MODULE is required')
}

jiti(workerModule)
