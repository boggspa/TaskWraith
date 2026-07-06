#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..')
const targets = process.argv.slice(2)
const directories = targets.length > 0 ? targets : ['dist']

for (const dir of directories) {
  const absolute = path.resolve(repoRoot, dir)
  if (!absolute.startsWith(repoRoot + path.sep)) {
    console.error(`[clean-dist] refusing to remove path outside repo: ${absolute}`)
    process.exit(2)
  }
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  console.log(`[clean-dist] removed ${path.relative(repoRoot, absolute) || absolute}`)
}
