'use strict'

const { runDetachedCoordinatorProcess } = require('./studio-acceptance-harness.cjs')

runDetachedCoordinatorProcess().catch((error) => {
  console.error(
    `[studio-acceptance-detached-coordinator] FAIL — ${
      error instanceof Error ? error.message : String(error)
    }`
  )
  process.exitCode = 1
})
