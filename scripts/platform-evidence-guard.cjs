#!/usr/bin/env node
'use strict'

/**
 * Platform-evidence guard — mechanical proof that the 1.9.3 cross-platform
 * evidence *loop configuration* has not drifted.
 *
 * PRECEDENT (2026-07, v1.9.0): five separate defects took out Linux, Windows,
 * and macOS-Intel legs on ship night. The local macOS gate could not see them.
 * The recovery loop is two layers:
 *
 *   1. Local countermeasures (platform-portability-guard + path-literal guard)
 *      that fail on greppable signatures of each defect class.
 *   2. A scheduled four-OS matrix in .github/workflows/ci.yml that actually
 *      runs the suite where those defects are visible.
 *
 * This guard binds those layers to a single contract file so a well-meaning
 * edit cannot silently drop a matrix leg, the nightly cron, a portability rule,
 * or the runner-identity breadcrumb — without waiting for the next ship night.
 *
 * HONESTY BOUNDARY (non-negotiable):
 *   Local success means "configuration matches the contract".
 *   Local success never means "remote legs ran / passed".
 *   Do not print or return language that claims remote matrix execution.
 *
 * Scope is deliberately tight: contract schema + text presence in tracked
 * workflow / package / portability sources. No network, no GitHub API, no
 * Actions log fetch.
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.join(__dirname, '..')
const CONTRACT_REPO_PATH = 'scripts/platform-evidence-contract.json'
const WORKFLOW_REPO_PATH = '.github/workflows/ci.yml'
const PACKAGE_REPO_PATH = 'package.json'
const PORTABILITY_GUARD_REPO_PATH = 'scripts/platform-portability-guard.cjs'
const SCHEMA_VERSION = 1

const REQUIRED_RULE_IDS = [
  'real-fs-mode',
  'posix-shebang',
  'system-path-literal-expectation',
  'executable-path-literal',
  'inode-identity',
  'encryption-availability',
  'buffer-structural-equality'
]

function readText(repoPath, repoRoot = REPO_ROOT) {
  return fs.readFileSync(path.join(repoRoot, repoPath), 'utf8')
}

function readJson(repoPath, repoRoot = REPO_ROOT) {
  return JSON.parse(readText(repoPath, repoRoot))
}

/**
 * Validate the contract shape. Throws on structural failure so a missing field
 * cannot pass as "aligned".
 */
function validateContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error(`${CONTRACT_REPO_PATH} must be a JSON object`)
  }
  if (contract.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${CONTRACT_REPO_PATH} must have schemaVersion: ${SCHEMA_VERSION} (got ${JSON.stringify(contract.schemaVersion)})`
    )
  }

  const cron = contract.schedule?.cron
  if (typeof cron !== 'string' || !/^\d{1,2} \d{1,2} \* \* \*$/.test(cron.trim())) {
    throw new Error(`${CONTRACT_REPO_PATH} schedule.cron must be a five-field daily cron string`)
  }

  const workflowPath = contract.schedule?.workflowPath
  if (workflowPath !== WORKFLOW_REPO_PATH) {
    throw new Error(
      `${CONTRACT_REPO_PATH} schedule.workflowPath must be ${WORKFLOW_REPO_PATH} (got ${JSON.stringify(workflowPath)})`
    )
  }

  const runners = contract.matrix?.runners
  if (!Array.isArray(runners) || runners.length !== 4) {
    throw new Error(`${CONTRACT_REPO_PATH} matrix.runners must list exactly four runners`)
  }

  const seenOs = new Set()
  const seenName = new Set()
  for (const runner of runners) {
    if (!runner || typeof runner !== 'object') {
      throw new Error(`${CONTRACT_REPO_PATH} matrix.runners entries must be objects`)
    }
    if (typeof runner.name !== 'string' || runner.name.trim().length === 0) {
      throw new Error(`${CONTRACT_REPO_PATH} matrix.runners[].name must be a non-empty string`)
    }
    if (typeof runner.os !== 'string' || runner.os.trim().length === 0) {
      throw new Error(`${CONTRACT_REPO_PATH} matrix.runners[].os must be a non-empty string`)
    }
    if (seenOs.has(runner.os)) {
      throw new Error(
        `${CONTRACT_REPO_PATH} matrix.runners has duplicate os ${JSON.stringify(runner.os)}`
      )
    }
    if (seenName.has(runner.name)) {
      throw new Error(
        `${CONTRACT_REPO_PATH} matrix.runners has duplicate name ${JSON.stringify(runner.name)}`
      )
    }
    seenOs.add(runner.os)
    seenName.add(runner.name)
  }

  const ruleIds = contract.localCountermeasures?.portabilityGuard?.ruleIds
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
    throw new Error(
      `${CONTRACT_REPO_PATH} localCountermeasures.portabilityGuard.ruleIds must be a non-empty array`
    )
  }
  if (new Set(ruleIds).size !== ruleIds.length) {
    throw new Error(
      `${CONTRACT_REPO_PATH} localCountermeasures.portabilityGuard.ruleIds contains duplicates`
    )
  }
  for (const id of REQUIRED_RULE_IDS) {
    if (!ruleIds.includes(id)) {
      throw new Error(
        `${CONTRACT_REPO_PATH} localCountermeasures.portabilityGuard.ruleIds is missing required id ${id}`
      )
    }
  }
  for (const id of ruleIds) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(`${CONTRACT_REPO_PATH} rule id ${JSON.stringify(id)} is not a lowercase slug`)
    }
  }

  const stepName = contract.ciEvidence?.runnerIdentityStepName
  if (typeof stepName !== 'string' || stepName.trim().length === 0) {
    throw new Error(
      `${CONTRACT_REPO_PATH} ciEvidence.runnerIdentityStepName must be a non-empty string`
    )
  }

  const honesty = contract.ciEvidence?.honesty
  if (
    typeof honesty !== 'string' ||
    !/does not prove that any remote matrix leg executed/i.test(honesty)
  ) {
    throw new Error(
      `${CONTRACT_REPO_PATH} ciEvidence.honesty must explicitly refuse to claim remote matrix execution`
    )
  }

  return contract
}

/** Extract `id: '…'` entries from the portability guard RULES array source. */
function parsePortabilityRuleIds(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error(`${PORTABILITY_GUARD_REPO_PATH} source is empty`)
  }
  if (!/const RULES\s*=\s*\[/.test(source)) {
    throw new Error(
      `${PORTABILITY_GUARD_REPO_PATH}: RULES declaration not found; refusing to pass vacuously`
    )
  }
  const ids = []
  const re = /\bid:\s*['"]([a-z][a-z0-9-]*)['"]/g
  let match
  while ((match = re.exec(source)) !== null) {
    ids.push(match[1])
  }
  if (ids.length === 0) {
    throw new Error(
      `${PORTABILITY_GUARD_REPO_PATH}: no rule ids parsed from RULES; refusing to pass vacuously`
    )
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${PORTABILITY_GUARD_REPO_PATH}: duplicate rule ids: ${ids.join(', ')}`)
  }
  return ids
}

/**
 * Pull the test job's matrix.include name/os pairs from the CI workflow.
 * Indentation-scoped so sibling jobs (ios, release, unsigned builds) do not
 * contribute false runners.
 */
function parseWorkflowMatrixRunners(workflowSource) {
  if (typeof workflowSource !== 'string' || workflowSource.length === 0) {
    throw new Error(`${WORKFLOW_REPO_PATH} source is empty`)
  }

  const lines = workflowSource.split('\n')
  let inJobs = false
  let inTestJob = false
  let inStrategy = false
  let inMatrix = false
  let inInclude = false
  let jobsIndent = -1
  let testIndent = -1
  let strategyIndent = -1
  let matrixIndent = -1
  let includeIndent = -1
  const runners = []
  let current = null

  const indentOf = (line) => line.match(/^(\s*)/)[1].length
  const flushCurrent = () => {
    if (current && current.name && current.os) runners.push(current)
    current = null
  }

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    const trimmed = line.trim()

    if (!inJobs && /^jobs:\s*$/.test(trimmed)) {
      inJobs = true
      jobsIndent = indent
      continue
    }
    if (!inJobs) continue

    if (indent <= jobsIndent && !/^jobs:\s*$/.test(trimmed)) {
      // Left the jobs: block entirely.
      flushCurrent()
      break
    }

    if (indent === jobsIndent + 2 && /^[A-Za-z0-9_-]+:\s*$/.test(trimmed)) {
      const jobId = trimmed.slice(0, -1)
      flushCurrent()
      inTestJob = jobId === 'test'
      inStrategy = false
      inMatrix = false
      inInclude = false
      testIndent = indent
      continue
    }

    if (!inTestJob) continue

    if (indent <= testIndent && indent > jobsIndent) {
      // Sibling job key — leave test job.
      flushCurrent()
      inTestJob = false
      inStrategy = false
      inMatrix = false
      inInclude = false
      continue
    }

    if (/^strategy:\s*$/.test(trimmed)) {
      inStrategy = true
      strategyIndent = indent
      inMatrix = false
      inInclude = false
      continue
    }
    if (inStrategy && indent <= strategyIndent) {
      // Leaving strategy (e.g. steps:) — flush the last include entry first.
      flushCurrent()
      inStrategy = false
      inMatrix = false
      inInclude = false
    }
    if (!inStrategy) continue

    if (/^matrix:\s*$/.test(trimmed)) {
      inMatrix = true
      matrixIndent = indent
      inInclude = false
      continue
    }
    if (inMatrix && indent <= matrixIndent) {
      flushCurrent()
      inMatrix = false
      inInclude = false
    }
    if (!inMatrix) continue

    if (/^include:\s*$/.test(trimmed)) {
      inInclude = true
      includeIndent = indent
      continue
    }
    if (inInclude && indent <= includeIndent) {
      flushCurrent()
      inInclude = false
    }
    if (!inInclude) continue

    // include entries: "- name: Linux" or indented "os: ubuntu-latest"
    const nameMatch = trimmed.match(/^-\s*name:\s*(.+?)\s*$/)
    if (nameMatch) {
      flushCurrent()
      current = { name: stripYamlScalar(nameMatch[1]), os: null }
      continue
    }
    const osMatch = trimmed.match(/^(?:-\s*)?os:\s*(.+?)\s*$/)
    if (osMatch && current) {
      current.os = stripYamlScalar(osMatch[1])
      continue
    }
  }
  flushCurrent()

  if (runners.length === 0) {
    throw new Error(
      `${WORKFLOW_REPO_PATH}: no matrix.include runners found under jobs.test; refusing to pass vacuously`
    )
  }
  return runners
}

function stripYamlScalar(value) {
  const v = value.trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1)
  }
  // Drop trailing inline comments.
  return v.replace(/\s+#.*$/, '').trim()
}

function parseWorkflowCrons(workflowSource) {
  const crons = []
  const re = /cron:\s*['"]([^'"]+)['"]/g
  let match
  while ((match = re.exec(workflowSource)) !== null) {
    crons.push(match[1].trim())
  }
  return crons
}

function workflowHasRunnerIdentityStep(workflowSource, stepName) {
  // YAML step name line: `name: Record runner identity`
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nameRe = new RegExp(`^\\s*-?\\s*name:\\s*${escaped}\\s*$`, 'm')
  if (!nameRe.test(workflowSource)) return false
  // Require the step actually records matrix + runner identity rather than a
  // empty named step that was left as a stub.
  const requiredSnippets = ['matrix.name', 'matrix.os', 'runner.os', 'runner.arch']
  return requiredSnippets.every((snippet) => workflowSource.includes(snippet))
}

function parsePackageScripts(packageSource) {
  let pkg
  try {
    pkg = JSON.parse(packageSource)
  } catch (error) {
    throw new Error(
      `${PACKAGE_REPO_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!pkg.scripts || typeof pkg.scripts !== 'object') {
    throw new Error(`${PACKAGE_REPO_PATH} has no scripts map`)
  }
  return pkg.scripts
}

/**
 * Pure evaluation — returns human-readable failure strings. Empty = aligned.
 * Never asserts remote execution.
 */
function evaluatePlatformEvidence(input) {
  const failures = []
  const contract = validateContract(input.contract)

  // Schedule
  const crons = parseWorkflowCrons(input.workflowSource)
  if (!crons.includes(contract.schedule.cron)) {
    failures.push(
      `schedule cron ${JSON.stringify(contract.schedule.cron)} is absent from ${WORKFLOW_REPO_PATH} (found: ${crons.map((c) => JSON.stringify(c)).join(', ') || 'none'})`
    )
  }

  // Matrix runners (name + os, order-independent)
  let workflowRunners
  try {
    workflowRunners = parseWorkflowMatrixRunners(input.workflowSource)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    workflowRunners = []
  }

  const expected = contract.matrix.runners.map((r) => ({ name: r.name, os: r.os }))
  const expectedKeys = new Set(expected.map((r) => `${r.name}\0${r.os}`))
  const actualKeys = new Set(workflowRunners.map((r) => `${r.name}\0${r.os}`))

  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) {
      const [name, os] = key.split('\0')
      failures.push(
        `matrix runner missing from ${WORKFLOW_REPO_PATH} jobs.test: name=${JSON.stringify(name)} os=${JSON.stringify(os)}`
      )
    }
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) {
      const [name, os] = key.split('\0')
      failures.push(
        `matrix runner present in ${WORKFLOW_REPO_PATH} but not in contract: name=${JSON.stringify(name)} os=${JSON.stringify(os)}`
      )
    }
  }

  // Runner-identity step
  const stepName = contract.ciEvidence.runnerIdentityStepName
  if (!workflowHasRunnerIdentityStep(input.workflowSource, stepName)) {
    failures.push(
      `${WORKFLOW_REPO_PATH} is missing CI step ${JSON.stringify(stepName)} (must record matrix.name, matrix.os, runner.os, runner.arch)`
    )
  }

  // Portability rule ids
  let portabilityIds
  try {
    portabilityIds = parsePortabilityRuleIds(input.portabilityGuardSource)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    portabilityIds = []
  }
  const contractRuleIds = contract.localCountermeasures.portabilityGuard.ruleIds
  for (const id of contractRuleIds) {
    if (!portabilityIds.includes(id)) {
      failures.push(
        `portability rule ${id} is in the contract but missing from ${PORTABILITY_GUARD_REPO_PATH}`
      )
    }
  }
  for (const id of portabilityIds) {
    if (!contractRuleIds.includes(id)) {
      failures.push(
        `portability rule ${id} exists in ${PORTABILITY_GUARD_REPO_PATH} but is not listed in the contract`
      )
    }
  }

  // package.json wiring
  let scripts
  try {
    scripts = parsePackageScripts(input.packageSource)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    scripts = {}
  }
  const evidenceScript = scripts['guard:platform-evidence']
  if (typeof evidenceScript !== 'string' || !evidenceScript.includes('platform-evidence-guard')) {
    failures.push(
      `${PACKAGE_REPO_PATH} scripts["guard:platform-evidence"] must invoke scripts/platform-evidence-guard.cjs`
    )
  }
  const ciScript = scripts.ci
  if (typeof ciScript !== 'string' || !ciScript.includes('guard:platform-evidence')) {
    failures.push(
      `${PACKAGE_REPO_PATH} scripts.ci must include npm run guard:platform-evidence so local CI chain checks the contract`
    )
  }
  const portabilityNpm = contract.localCountermeasures.portabilityGuard.npmScript
  if (typeof scripts[portabilityNpm] !== 'string') {
    failures.push(
      `${PACKAGE_REPO_PATH} is missing the local countermeasure script ${JSON.stringify(portabilityNpm)}`
    )
  }

  return failures
}

function collectPlatformEvidenceSources(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT
  const contract = validateContract(readJson(CONTRACT_REPO_PATH, repoRoot))
  return {
    contract,
    workflowSource: readText(WORKFLOW_REPO_PATH, repoRoot),
    packageSource: readText(PACKAGE_REPO_PATH, repoRoot),
    portabilityGuardSource: readText(PORTABILITY_GUARD_REPO_PATH, repoRoot)
  }
}

function main() {
  try {
    const sources = collectPlatformEvidenceSources()
    const failures = evaluatePlatformEvidence(sources)
    if (failures.length > 0) {
      console.error(
        '[platform-evidence-guard] FAILED — cross-platform evidence configuration drifted from the contract:'
      )
      for (const failure of failures) console.error(`  ✗ ${failure}`)
      console.error(
        '\n  This gate checks configuration only. A red result does not mean remote CI failed; a green result does not mean remote matrix legs ran.'
      )
      process.exitCode = 1
      return
    }
    const runners = sources.contract.matrix.runners.map((r) => `${r.name}/${r.os}`).join(', ')
    console.log(
      `[platform-evidence-guard] ok — configuration aligned: cron ${sources.contract.schedule.cron}; matrix [${runners}]; ${sources.contract.localCountermeasures.portabilityGuard.ruleIds.length} portability rule ids; runner-identity step present. Local proof of config only — does not claim remote matrix legs ran.`
    )
  } catch (error) {
    console.error(
      `[platform-evidence-guard] FAILED — ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  CONTRACT_REPO_PATH,
  REQUIRED_RULE_IDS,
  SCHEMA_VERSION,
  WORKFLOW_REPO_PATH,
  collectPlatformEvidenceSources,
  evaluatePlatformEvidence,
  parsePortabilityRuleIds,
  parseWorkflowCrons,
  parseWorkflowMatrixRunners,
  validateContract,
  workflowHasRunnerIdentityStep
}

if (require.main === module) main()
