import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  expectedReleaseRunName,
  parseArgs,
  successfulReleaseAttestation
}: {
  expectedReleaseRunName: (sha: string) => string
  parseArgs: (args: string[]) => {
    input: string
    sha: string
    defaultBranch: string
    runName: string | null
    now: string
    maxAgeHours: number
  }
  successfulReleaseAttestation: (
    payload: unknown,
    options: {
      sha: string
      defaultBranch: string
      runName?: string | null
      now: string
      maxAgeHours: number
    }
  ) => Record<string, unknown> | null
} = require('./verify-provider-release-attestation.cjs')

const SHA = 'a'.repeat(40)
const NOW = '2026-07-19T12:00:00Z'
const OPTIONS = { sha: SHA, defaultBranch: 'master', now: NOW, maxAgeHours: 24 }

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    name: 'Provider permission conformance',
    display_title: expectedReleaseRunName(SHA),
    head_sha: SHA,
    head_branch: 'master',
    event: 'repository_dispatch',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: '2026-07-19T10:59:00Z',
    updated_at: '2026-07-19T11:00:00Z',
    ...overrides
  }
}

function workflowStepsWithDuplicateEnv(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const duplicates: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].match(/^(\s*)-\s+(?:name|uses|run):\s*(.*)$/)
    if (!start) continue
    const itemIndent = start[1].length
    const envIndent = ' '.repeat(itemIndent + 2)
    let envCount = 0
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.match(new RegExp(`^\\s{${itemIndent}}-\\s+`))) break
      if (line.trim() && line.search(/\S/) <= itemIndent) break
      if (line === `${envIndent}env:`) envCount += 1
    }
    if (envCount > 1) duplicates.push(start[2].trim() || `step at line ${index + 1}`)
  }
  return duplicates
}

describe('provider release attestation', () => {
  it('accepts only a fresh successful release dispatch for the exact candidate SHA', () => {
    expect(
      successfulReleaseAttestation(
        {
          workflow_runs: [
            run({ id: 122, conclusion: 'failure', created_at: '2026-07-19T10:00:00Z' }),
            run({ id: 123, created_at: '2026-07-19T11:00:00Z' })
          ]
        },
        OPTIONS
      )
    ).toMatchObject({ id: 123, head_sha: SHA })
  })

  it.each([
    ['failed', { status: 'completed', conclusion: 'failure' }],
    ['in progress', { status: 'in_progress', conclusion: null }]
  ])('rejects an older success when the newest exact run is %s', (_label, newestState) => {
    const olderSuccess = run({ id: 200, created_at: '2026-07-19T10:00:00Z' })
    const newest = run({ id: 201, created_at: '2026-07-19T11:00:00Z', ...newestState })
    expect(
      successfulReleaseAttestation({ workflow_runs: [olderSuccess, newest] }, OPTIONS)
    ).toBeNull()
    expect(
      successfulReleaseAttestation({ workflow_runs: [newest, olderSuccess] }, OPTIONS)
    ).toBeNull()
  })

  it('uses run id to break equal-created-at ties independently of API order', () => {
    const olderIdSuccess = run({ id: 300, created_at: '2026-07-19T11:00:00Z' })
    const newerIdFailure = run({
      id: 301,
      created_at: '2026-07-19T11:00:00Z',
      conclusion: 'failure'
    })
    expect(
      successfulReleaseAttestation({ workflow_runs: [newerIdFailure, olderIdSuccess] }, OPTIONS)
    ).toBeNull()
  })

  it.each([
    ['wrong SHA', { head_sha: 'b'.repeat(40) }],
    ['wrong run name', { display_title: `provider-permission-qualification @ ${SHA}` }],
    ['wrong workflow', { name: 'CI' }],
    ['wrong branch', { head_branch: 'feature' }],
    ['wrong event', { event: 'workflow_dispatch' }],
    ['still running', { status: 'in_progress' }],
    ['failed', { conclusion: 'failure' }]
  ])('rejects %s', (_label, overrides) => {
    expect(successfulReleaseAttestation({ workflow_runs: [run(overrides)] }, OPTIONS)).toBeNull()
  })

  it.each([
    ['older than the freshness window', { created_at: '2026-07-18T11:59:59Z' }],
    ['a future creation timestamp', { created_at: '2026-07-19T12:00:01Z' }],
    ['a malformed creation timestamp', { created_at: 'not-a-timestamp' }],
    ['an impossible creation timestamp', { created_at: '2026-02-31T11:00:00Z' }],
    ['a missing creation timestamp', { created_at: undefined }],
    ['a rerun attempt', { run_attempt: 2 }]
  ])('rejects %s', (_label, overrides) => {
    expect(successfulReleaseAttestation({ workflow_runs: [run(overrides)] }, OPTIONS)).toBeNull()
  })

  it('accepts a first-attempt run created exactly at the 24-hour boundary', () => {
    expect(
      successfulReleaseAttestation(
        { workflow_runs: [run({ created_at: '2026-07-18T12:00:00Z' })] },
        OPTIONS
      )
    ).toMatchObject({ id: 123 })
  })

  it('does not let a fresh partial-rerun update refresh a stale dispatch', () => {
    expect(
      successfulReleaseAttestation(
        {
          workflow_runs: [
            run({
              run_attempt: 2,
              created_at: '2026-07-18T11:00:00Z',
              updated_at: '2026-07-19T11:59:00Z'
            })
          ]
        },
        OPTIONS
      )
    ).toBeNull()
  })

  it('validates full-SHA and freshness CLI input', () => {
    expect(
      parseArgs(['--input=runs.json', `--sha=${SHA}`, `--now=${NOW}`, '--max-age-hours=24'])
    ).toMatchObject({
      input: 'runs.json',
      sha: SHA,
      defaultBranch: 'master',
      now: NOW,
      maxAgeHours: 24
    })
    expect(() => parseArgs(['--input=runs.json', '--sha=short', `--now=${NOW}`])).toThrow(
      'full hexadecimal'
    )
    expect(() => parseArgs(['--input=runs.json', `--sha=${SHA}`])).toThrow('--now')
    expect(() => parseArgs(['--input=runs.json', `--sha=${SHA}`, '--now=not-a-timestamp'])).toThrow(
      '--now'
    )
    expect(() => parseArgs(['--input=runs.json', `--sha=${SHA}`, '--now=2026-07-19'])).toThrow(
      '--now'
    )
    expect(() =>
      parseArgs(['--input=runs.json', `--sha=${SHA}`, `--now=${NOW}`, '--max-age-hours=0'])
    ).toThrow('positive number')
  })

  it('rejects malformed GitHub response shapes', () => {
    expect(() => successfulReleaseAttestation({}, OPTIONS)).toThrow('workflow_runs')
  })
})

describe('release workflow publication policy', () => {
  const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
  const canaryWorkflow = readFileSync(
    join(process.cwd(), '.github/workflows/provider-containment-canaries.yml'),
    'utf8'
  )

  it('keeps manual unsigned builds outside the GitHub Release write surface', () => {
    const unsignedJobs = ciWorkflow.slice(ciWorkflow.indexOf('\n  unsigned-windows-build:'))
    expect(unsignedJobs).toContain('inputs.build_unsigned_windows == true')
    expect(unsignedJobs).toContain('inputs.build_unsigned_linux == true')
    expect(unsignedJobs).not.toContain('windows_release_tag')
    expect(unsignedJobs).not.toContain('linux_release_tag')
    expect(unsignedJobs).not.toContain('contents: write')
    expect(unsignedJobs).not.toContain('GH_TOKEN')
    expect(unsignedJobs).not.toContain('gh release')
    expect(
      unsignedJobs.match(/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/g)
    ).toHaveLength(2)
    expect(unsignedJobs).toContain(
      'unsigned-windows-testing-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'
    )
    expect(unsignedJobs).toContain(
      'unsigned-linux-testing-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'
    )
  })

  it('fails closed until the protected credentialed canary lane is commissioned and passes', () => {
    expect(canaryWorkflow).toContain('run-name: ${{ github.event.action }} @ ${{ github.sha }}')
    expect(canaryWorkflow).toContain('environment-configuration-gate:')
    expect(canaryWorkflow).toContain("if: vars.PROVIDER_CANARY_ENVIRONMENT_CONFIGURED == 'true'")
    expect(canaryWorkflow).toContain('needs: environment-configuration-gate')
    expect(canaryWorkflow).toContain('needs: [environment-configuration-gate, live-containment]')
    expect(canaryWorkflow).toContain('test "$CONFIGURATION_RESULT" = "success"')
    expect(canaryWorkflow).toContain('test "$LIVE_CONTAINMENT_RESULT" = "success"')
    expect(workflowStepsWithDuplicateEnv(canaryWorkflow)).toEqual([])
  })

  it('detects duplicate env mappings within one workflow step', () => {
    expect(
      workflowStepsWithDuplicateEnv(`steps:
  - name: malformed
    env:
      FIRST: one
    env:
      SECOND: two
  - name: valid
    env:
      THIRD: three
`)
    ).toEqual(['malformed'])
  })

  it('binds each dispatch action to its exact canary command and strict release post-gate', () => {
    const qualificationStep = canaryWorkflow.slice(
      canaryWorkflow.indexOf('- name: Produce qualification-candidate evidence'),
      canaryWorkflow.indexOf('- name: Enforce reviewed provider fingerprints')
    )
    const releaseStep = canaryWorkflow.slice(
      canaryWorkflow.indexOf('- name: Enforce reviewed provider fingerprints'),
      canaryWorkflow.indexOf('- name: Validate strict release evidence semantics')
    )
    const aggregateStep = canaryWorkflow.slice(
      canaryWorkflow.indexOf('- name: Validate strict release evidence semantics'),
      canaryWorkflow.indexOf('- name: Remove provider credentials')
    )

    expect(qualificationStep).toContain(
      "if: github.event.action == 'provider-permission-qualification'"
    )
    expect(qualificationStep).toContain('run: npm run verify:provider-permissions:live')
    expect(qualificationStep).not.toContain('verify:provider-permissions:release')
    expect(releaseStep).toContain("if: github.event.action == 'provider-permission-release'")
    expect(releaseStep).toContain('run: npm run verify:provider-permissions:release')
    expect(releaseStep).not.toContain('verify:provider-permissions:live')
    expect(aggregateStep).toContain("if: github.event.action == 'provider-permission-release'")
    expect(aggregateStep).toContain('scripts/verify-provider-canary-aggregate.cjs')
    expect(aggregateStep).toContain('--sha="$GITHUB_SHA"')
  })

  it('uses a fresh hosted native Kimi lane and scrubs credentials before artifact actions', () => {
    expect(canaryWorkflow).toContain('runs-on: macos-15')
    expect(canaryWorkflow).not.toContain('runs-on: [self-hosted')
    expect(canaryWorkflow).toContain(
      'https://code.kimi.com/kimi-code/binaries/0.27.0/kimi-code-darwin-arm64'
    )
    expect(canaryWorkflow).toContain(
      '550bca0ba6e474f4e0faeadfae03a9294c7c25688670f38ff488ab8cf176d817'
    )
    expect(canaryWorkflow).toContain(
      'KIMI_CODE_CANARY_API_KEY: ${{ secrets.KIMI_CODE_CANARY_API_KEY }}'
    )
    expect(canaryWorkflow).toContain('base_url = "https://api.kimi.com/coding/v1"')
    expect(canaryWorkflow).toContain('model = "kimi-for-coding"')
    expect(canaryWorkflow).toContain('persist-credentials: false')

    const secretMaterialization = canaryWorkflow.indexOf(
      '- name: Materialize protected non-rotating Kimi API-key profile'
    )
    const scrub = canaryWorkflow.indexOf('- name: Remove provider credentials')
    const upload = canaryWorkflow.indexOf(
      '- name: Upload sanitized canary evidence after credential scrub'
    )
    expect(secretMaterialization).toBeGreaterThan(-1)
    expect(scrub).toBeGreaterThan(secretMaterialization)
    expect(upload).toBeGreaterThan(scrub)
    expect(canaryWorkflow.slice(secretMaterialization, scrub)).not.toContain('uses:')
    expect(canaryWorkflow.slice(upload)).toContain("steps.scrub.outcome == 'success'")
  })

  it('binds signed publication to a fresh exact-commit attestation', () => {
    expect(ciWorkflow).toContain(
      'RELEASE_TAG_PROTECTION_CONFIGURED: ${{ vars.RELEASE_TAG_PROTECTION_CONFIGURED }}'
    )
    expect(ciWorkflow).toContain(
      'PROVIDER_CANARY_ENVIRONMENT_CONFIGURED: ${{ vars.PROVIDER_CANARY_ENVIRONMENT_CONFIGURED }}'
    )
    expect(ciWorkflow).toContain('test "$RELEASE_TAG_PROTECTION_CONFIGURED" = "true"')
    expect(ciWorkflow).toContain('test "$PROVIDER_CANARY_ENVIRONMENT_CONFIGURED" = "true"')
    expect(ciWorkflow).toContain('candidate_sha="$(git rev-parse HEAD)"')
    expect(ciWorkflow).toContain('--now="$attestation_now"')
    expect(ciWorkflow.match(/--max-age-hours=24/g)).toHaveLength(3)
    expect(ciWorkflow.match(/verify-provider-release-attestation\.cjs/g)).toHaveLength(3)
    expect(
      ciWorkflow.match(/actions\/workflows\/provider-containment-canaries\.yml\/runs/g)
    ).toHaveLength(3)
    expect(ciWorkflow.match(/actions: read/g)).toHaveLength(3)
    expect(ciWorkflow).not.toContain('-f status=completed')
    expect(ciWorkflow.match(/needs: \[test, ios, provider-permission-attestation\]/g)).toHaveLength(
      2
    )
    expect(ciWorkflow.match(/gh release create .* --verify-tag/g)).toHaveLength(2)
    expect(ciWorkflow).toContain('git fetch --force --no-tags origin "+$tag_ref:$tag_ref"')
    expect(ciWorkflow).toContain('$refspec = "+{0}:{0}" -f $tagRef')
    expect(ciWorkflow).toContain('Remote release tag resolves to $remote_tag_sha')
    expect(ciWorkflow).toContain('Remote release tag resolves to $remoteTagSha')

    const macPublisher = ciWorkflow.slice(
      ciWorkflow.indexOf('\n  notarized-macos-release:'),
      ciWorkflow.indexOf('\n  signed-windows-release:')
    )
    const windowsPublisher = ciWorkflow.slice(
      ciWorkflow.indexOf('\n  signed-windows-release:'),
      ciWorkflow.indexOf('\n  unsigned-windows-build:')
    )
    for (const publisher of [macPublisher, windowsPublisher]) {
      expect(publisher).toContain('actions: read')
      expect(publisher).toContain('PROVIDER_CANARY_ENVIRONMENT_CONFIGURED')
      expect(publisher).toContain('RELEASE_TAG_PROTECTION_CONFIGURED')
      expect(publisher).toContain('provider-containment-canaries.yml/runs')
      expect(publisher).toContain('verify-provider-release-attestation.cjs')
      expect(publisher).toContain('--max-age-hours=24')
      expect(publisher).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5')
      expect(publisher).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
      expect(publisher).toContain('persist-credentials: false')
      expect(publisher).not.toMatch(/\n {4}env:\n/)
    }

    const macSigningStep = macPublisher.slice(
      macPublisher.indexOf('- name: Sign, package, and notarize macOS artifacts'),
      macPublisher.indexOf('- name: Run post-package macOS checks')
    )
    const windowsSigningStep = windowsPublisher.slice(
      windowsPublisher.indexOf('- name: Sign and package Windows artifacts'),
      windowsPublisher.indexOf('- name: Run post-package Windows checks')
    )
    expect(macSigningStep).toContain('APPLE_ID: ${{ secrets.APPLE_ID }}')
    expect(macSigningStep).toContain('CSC_LINK: ${{ secrets.MACOS_CSC_LINK }}')
    expect(windowsSigningStep).toContain('CSC_LINK: ${{ secrets.WINDOWS_CSC_LINK }}')
    expect(macPublisher.match(/\$\{\{ secrets\./g)).toHaveLength(7)
    expect(windowsPublisher.match(/\$\{\{ secrets\./g)).toHaveLength(2)
  })
})
