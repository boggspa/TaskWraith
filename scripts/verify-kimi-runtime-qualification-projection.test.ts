import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseArgs,
  projectKimiRuntimeQualifications,
  RUNTIME_FIELDS,
  validateEmbeddedRoster,
  verifyProjection
}: {
  parseArgs: (args: string[]) => { manifest: string; embedded: string; write: boolean }
  projectKimiRuntimeQualifications: (manifest: unknown) => {
    qualifications: Array<Record<string, unknown>>
    errors: string[]
  }
  RUNTIME_FIELDS: readonly string[]
  validateEmbeddedRoster: (embedded: unknown) => string[]
  verifyProjection: (
    manifest: unknown,
    embedded: unknown,
    source?: string,
    builder?: string
  ) => { ok: boolean; errors: string[]; qualifications: Array<Record<string, unknown>> }
} = require('./verify-kimi-runtime-qualification-projection.cjs')

const SHA_A = `sha256:${'a'.repeat(64)}`
const SHA_B = `sha256:${'b'.repeat(64)}`

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binarySha256: SHA_A,
    platform: 'darwin',
    arch: 'arm64',
    scope: 'acp-synthetic-cwd-gateway-v1',
    version: '0.27.0',
    capabilityFingerprint: SHA_B,
    postureVersion: 'synthetic-cwd-gateway-v1',
    attestationSource: 'credentialed-live-containment-canary',
    distribution: 'official-native-single-binary',
    harnessNodeVersion: 'v22.19.0',
    authentication: 'kimi-code-provider-api-key',
    backendBaseUrl: 'https://api.kimi.com/coding/v1',
    modelAlias: 'kimi-code/kimi-for-coding',
    model: 'kimi-for-coding',
    ...overrides
  }
}

function manifest(entries: unknown[] = [entry()]): Record<string, unknown> {
  return { schemaVersion: 1, providers: { kimi: entries, cursor: [] } }
}

describe('Kimi runtime qualification projection verifier', () => {
  it('projects only exact runtime fields and strips release-liveness metadata', () => {
    const result = projectKimiRuntimeQualifications(manifest())
    expect(result.errors).toEqual([])
    expect(result.qualifications).toHaveLength(1)
    expect(Object.keys(result.qualifications[0]).sort()).toEqual([...RUNTIME_FIELDS].sort())
    expect(result.qualifications[0]).not.toHaveProperty('distribution')
    expect(result.qualifications[0]).not.toHaveProperty('harnessNodeVersion')
    expect(result.qualifications[0]).not.toHaveProperty('authentication')
    expect(result.qualifications[0]).not.toHaveProperty('backendBaseUrl')
    expect(result.qualifications[0]).not.toHaveProperty('modelAlias')
    expect(result.qualifications[0]).not.toHaveProperty('model')
  })

  it('accepts the intentionally empty manifest and embedded roster', () => {
    expect(verifyProjection(manifest([]), [])).toMatchObject({ ok: true, errors: [] })
  })

  it.each([
    ['scope', 'wrong-scope', '.scope must be exactly'],
    ['postureVersion', 'legacy', '.postureVersion must be exactly'],
    ['attestationSource', 'manual', '.attestationSource must be exactly'],
    ['binarySha256', 'not-a-digest', '.binarySha256 must be an exact sha256'],
    ['capabilityFingerprint', 'not-a-digest', '.capabilityFingerprint must be an exact sha256']
  ])('rejects an invalid release %s', (field, value, expected) => {
    const result = projectKimiRuntimeQualifications(manifest([entry({ [field]: value })]))
    expect(result.errors.some((error) => error.includes(expected))).toBe(true)
    expect(result.qualifications).toEqual([])
  })

  it('rejects parity drift and liveness-only fields in the embedded roster', () => {
    const projected = projectKimiRuntimeQualifications(manifest()).qualifications
    expect(verifyProjection(manifest(), [])).toMatchObject({ ok: false })
    expect(validateEmbeddedRoster([{ ...projected[0], distribution: 'must-not-ship' }])).toContain(
      'embedded qualification[0] must contain only the exact runtime projection fields'
    )
  })

  it('requires the runtime import and package scripts exclusion', () => {
    const projected = projectKimiRuntimeQualifications(manifest()).qualifications
    expect(
      verifyProjection(
        manifest(),
        projected,
        "from './KimiRuntimeQualifications.generated.json'",
        "- '!scripts/**'"
      )
    ).toMatchObject({ ok: true })
    expect(verifyProjection(manifest(), projected, 'hardcoded roster', "- '!scripts/**'").ok).toBe(
      false
    )
    expect(
      verifyProjection(
        manifest(),
        projected,
        "from './KimiRuntimeQualifications.generated.json'",
        'files: []'
      ).ok
    ).toBe(false)
  })

  it('parses verify/write paths and rejects ambiguous input', () => {
    expect(parseArgs([]).write).toBe(false)
    expect(parseArgs(['--write', '--manifest=a.json', '--embedded', 'b.json'])).toMatchObject({
      write: true,
      manifest: expect.stringMatching(/a\.json$/),
      embedded: expect.stringMatching(/b\.json$/)
    })
    expect(() => parseArgs(['--write', '--write'])).toThrow('only once')
    expect(() => parseArgs(['--manifest'])).toThrow('requires a value')
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown option')
  })

  it('keeps checked-in manifest and generated runtime roster exactly aligned', () => {
    const releaseManifest = JSON.parse(
      readFileSync(join(process.cwd(), 'scripts/provider-containment-fingerprints.json'), 'utf8')
    )
    const embedded = JSON.parse(
      readFileSync(
        join(process.cwd(), 'src/main/kimi/KimiRuntimeQualifications.generated.json'),
        'utf8'
      )
    )
    const runtimeSource = readFileSync(
      join(process.cwd(), 'src/main/kimi/KimiRuntimeAdmission.ts'),
      'utf8'
    )
    const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(verifyProjection(releaseManifest, embedded, runtimeSource, builder)).toMatchObject({
      ok: true,
      errors: []
    })
  })

  it('runs parity verification in build, CI, validation, and credentialed canary lanes', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    const releaseValidation = readFileSync(
      join(process.cwd(), 'scripts/validate-release.cjs'),
      'utf8'
    )
    const canaryWorkflow = readFileSync(
      join(process.cwd(), '.github/workflows/provider-containment-canaries.yml'),
      'utf8'
    )
    expect(packageJson.scripts['verify:kimi-runtime-qualifications']).toBe(
      'node scripts/verify-kimi-runtime-qualification-projection.cjs'
    )
    expect(packageJson.scripts.ci).toContain('npm run verify:kimi-runtime-qualifications')
    expect(packageJson.scripts.build).toContain('npm run verify:kimi-runtime-qualifications')
    expect(releaseValidation).toContain("step('kimi-runtime-qualification-projection'")
    expect(releaseValidation).toContain("args: ['run', 'verify:kimi-runtime-qualifications']")
    expect(canaryWorkflow).toContain('run: npm run verify:kimi-runtime-qualifications')
  })
})
