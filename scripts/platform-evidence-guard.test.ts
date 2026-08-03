import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  REQUIRED_RULE_IDS,
  collectPlatformEvidenceSources,
  evaluatePlatformEvidence,
  parsePortabilityRuleIds,
  parseWorkflowCrons,
  parseWorkflowMatrixRunners,
  validateContract,
  workflowHasRunnerIdentityStep
} = require('./platform-evidence-guard.cjs') as {
  REQUIRED_RULE_IDS: string[]
  collectPlatformEvidenceSources: (options?: { repoRoot?: string }) => {
    contract: ReturnType<typeof validateContract>
    workflowSource: string
    packageSource: string
    portabilityGuardSource: string
  }
  evaluatePlatformEvidence: (input: {
    contract: unknown
    workflowSource: string
    packageSource: string
    portabilityGuardSource: string
  }) => string[]
  parsePortabilityRuleIds: (source: string) => string[]
  parseWorkflowCrons: (source: string) => string[]
  parseWorkflowMatrixRunners: (source: string) => Array<{ name: string; os: string }>
  validateContract: (contract: unknown) => {
    schemaVersion: number
    schedule: { cron: string; workflowPath: string }
    matrix: { runners: Array<{ name: string; os: string }> }
    localCountermeasures: { portabilityGuard: { ruleIds: string[]; npmScript: string } }
    ciEvidence: { runnerIdentityStepName: string; honesty: string }
  }
  workflowHasRunnerIdentityStep: (source: string, stepName: string) => boolean
}

const BASE_CONTRACT = {
  schemaVersion: 1,
  schedule: {
    cron: '17 3 * * *',
    workflowPath: '.github/workflows/ci.yml'
  },
  matrix: {
    jobId: 'test',
    runners: [
      { name: 'Linux', os: 'ubuntu-latest' },
      { name: 'macOS Apple Silicon', os: 'macos-15' },
      { name: 'macOS Intel', os: 'macos-15-intel' },
      { name: 'Windows', os: 'windows-latest' }
    ]
  },
  localCountermeasures: {
    portabilityGuard: {
      scriptPath: 'scripts/platform-portability-guard.cjs',
      npmScript: 'guard:platform-portability',
      ruleIds: [...REQUIRED_RULE_IDS]
    }
  },
  ciEvidence: {
    runnerIdentityStepName: 'Record runner identity',
    honesty:
      'A green local guard proves configuration drift is absent. It does not prove that any remote matrix leg executed, passed, or recorded identity.'
  }
}

function workflowFixture(opts?: {
  cron?: string
  runners?: Array<{ name: string; os: string }>
  identityStep?: boolean
}): string {
  const cron = opts?.cron ?? '17 3 * * *'
  const runners = opts?.runners ?? BASE_CONTRACT.matrix.runners
  const identity =
    opts?.identityStep === false
      ? ''
      : `
      - name: Record runner identity
        run: |
          echo "matrix.name=/${'${{ matrix.name }}'}"
          echo "matrix.os=/${'${{ matrix.os }}'}"
          echo "runner.os=/${'${{ runner.os }}'}"
          echo "runner.arch=/${'${{ runner.arch }}'}"
`
  const include = runners
    .map((r) => `          - name: ${r.name}\n            os: ${r.os}`)
    .join('\n')
  return `
name: CI
on:
  schedule:
    - cron: '${cron}'
jobs:
  test:
    name: Test
    runs-on: /${'${{ matrix.os }}'}
    strategy:
      matrix:
        include:
${include}
    steps:
      - uses: actions/checkout@v4
${identity}      - run: npm ci
  ios:
    runs-on: macos-26
    steps:
      - run: echo ios
`
}

function packageFixture(opts?: {
  evidence?: boolean
  inCi?: boolean
  portability?: boolean
}): string {
  const scripts: Record<string, string> = {}
  if (opts?.portability !== false) {
    scripts['guard:platform-portability'] = 'node scripts/platform-portability-guard.cjs'
  }
  if (opts?.evidence !== false) {
    scripts['guard:platform-evidence'] = 'node scripts/platform-evidence-guard.cjs'
  }
  const ciParts = ['npm run lint:errors']
  if (opts?.inCi !== false) ciParts.push('npm run guard:platform-evidence')
  scripts.ci = ciParts.join(' && ')
  return JSON.stringify({ name: 'taskwraith', scripts }, null, 2)
}

function portabilityFixture(ids: string[] = REQUIRED_RULE_IDS): string {
  const rules = ids.map((id) => `  { id: '${id}', summary: 'x' }`).join(',\n')
  return `const RULES = [\n${rules}\n]\nmodule.exports = { RULES }\n`
}

describe('platform-evidence guard', () => {
  it('passes against the working tree: contract matches CI, package scripts, and portability rules', () => {
    const sources = collectPlatformEvidenceSources()
    expect(sources.contract.schedule.cron).toBe('17 3 * * *')
    expect(sources.contract.matrix.runners).toHaveLength(4)
    expect(evaluatePlatformEvidence(sources)).toEqual([])
  })

  it('success path language never claims remote legs ran', () => {
    const sources = collectPlatformEvidenceSources()
    expect(evaluatePlatformEvidence(sources)).toEqual([])
    expect(sources.contract.ciEvidence.honesty).toMatch(
      /does not prove that any remote matrix leg executed/i
    )
  })

  describe('validateContract', () => {
    it('accepts the baseline contract shape', () => {
      expect(validateContract(structuredClone(BASE_CONTRACT)).schemaVersion).toBe(1)
    })

    it('rejects wrong schema version and incomplete runners', () => {
      expect(() => validateContract({ ...BASE_CONTRACT, schemaVersion: 99 })).toThrow(
        /schemaVersion/
      )
      expect(() =>
        validateContract({
          ...BASE_CONTRACT,
          matrix: { runners: BASE_CONTRACT.matrix.runners.slice(0, 2) }
        })
      ).toThrow(/exactly four/)
    })

    it('requires all seven portability rule ids and honesty text', () => {
      expect(() =>
        validateContract({
          ...BASE_CONTRACT,
          localCountermeasures: {
            portabilityGuard: {
              ...BASE_CONTRACT.localCountermeasures.portabilityGuard,
              ruleIds: REQUIRED_RULE_IDS.filter((id) => id !== 'inode-identity')
            }
          }
        })
      ).toThrow(/inode-identity/)
      expect(() =>
        validateContract({
          ...BASE_CONTRACT,
          ciEvidence: {
            ...BASE_CONTRACT.ciEvidence,
            honesty: 'everything is fine remotely'
          }
        })
      ).toThrow(/refuse to claim remote/)
    })
  })

  describe('workflow parsing', () => {
    it('extracts schedule crons', () => {
      expect(parseWorkflowCrons(workflowFixture())).toEqual(['17 3 * * *'])
    })

    it('extracts only the test job matrix runners, not sibling jobs', () => {
      expect(parseWorkflowMatrixRunners(workflowFixture())).toEqual(BASE_CONTRACT.matrix.runners)
    })

    it('detects the runner-identity step and its required fields', () => {
      expect(workflowHasRunnerIdentityStep(workflowFixture(), 'Record runner identity')).toBe(true)
      expect(
        workflowHasRunnerIdentityStep(
          workflowFixture({ identityStep: false }),
          'Record runner identity'
        )
      ).toBe(false)
    })

    it('fails loudly when the test matrix is missing', () => {
      expect(() =>
        parseWorkflowMatrixRunners('jobs:\n  other:\n    runs-on: ubuntu-latest\n')
      ).toThrow(/refusing to pass vacuously/)
    })
  })

  describe('portability rule parsing', () => {
    it('reads rule ids from the RULES array', () => {
      expect(parsePortabilityRuleIds(portabilityFixture())).toEqual(REQUIRED_RULE_IDS)
    })

    it('refuses to pass vacuously without a RULES declaration', () => {
      expect(() => parsePortabilityRuleIds('module.exports = {}')).toThrow(
        /RULES declaration not found/
      )
    })
  })

  describe('evaluatePlatformEvidence', () => {
    const aligned = () => ({
      contract: structuredClone(BASE_CONTRACT),
      workflowSource: workflowFixture(),
      packageSource: packageFixture(),
      portabilityGuardSource: portabilityFixture()
    })

    it('returns no failures when everything aligns', () => {
      expect(evaluatePlatformEvidence(aligned())).toEqual([])
    })

    it('flags a dropped matrix leg', () => {
      const input = aligned()
      input.workflowSource = workflowFixture({
        runners: BASE_CONTRACT.matrix.runners.filter((r) => r.os !== 'windows-latest')
      })
      const failures = evaluatePlatformEvidence(input)
      expect(failures.some((f) => /windows-latest/.test(f))).toBe(true)
    })

    it('flags a drifted cron', () => {
      const input = aligned()
      input.workflowSource = workflowFixture({ cron: '0 0 * * *' })
      const failures = evaluatePlatformEvidence(input)
      expect(failures.some((f) => /17 3 \* \* \*/.test(f))).toBe(true)
    })

    it('flags a missing runner-identity step', () => {
      const input = aligned()
      input.workflowSource = workflowFixture({ identityStep: false })
      const failures = evaluatePlatformEvidence(input)
      expect(failures.some((f) => /Record runner identity/.test(f))).toBe(true)
    })

    it('flags a missing package script or ci chain entry', () => {
      expect(
        evaluatePlatformEvidence({
          ...aligned(),
          packageSource: packageFixture({ evidence: false })
        }).some((f) => /guard:platform-evidence/.test(f))
      ).toBe(true)
      expect(
        evaluatePlatformEvidence({
          ...aligned(),
          packageSource: packageFixture({ inCi: false })
        }).some((f) => /scripts\.ci/.test(f))
      ).toBe(true)
    })

    it('flags portability rule drift in either direction', () => {
      const missing = evaluatePlatformEvidence({
        ...aligned(),
        portabilityGuardSource: portabilityFixture(
          REQUIRED_RULE_IDS.filter((id) => id !== 'encryption-availability')
        )
      })
      expect(missing.some((f) => /encryption-availability/.test(f))).toBe(true)

      const extra = evaluatePlatformEvidence({
        ...aligned(),
        portabilityGuardSource: portabilityFixture([...REQUIRED_RULE_IDS, 'brand-new-rule'])
      })
      expect(extra.some((f) => /brand-new-rule/.test(f))).toBe(true)
    })
  })
})
