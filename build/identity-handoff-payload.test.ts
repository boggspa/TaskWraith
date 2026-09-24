import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  ARTIFACT_CONTRACT,
  baseManifest
}: {
  ARTIFACT_CONTRACT: Record<string, Record<string, unknown>>
  baseManifest: (
    prepared: boolean,
    artifacts?: Record<string, unknown>,
    sourceCommit?: string | null
  ) => Record<string, unknown>
} = require('../scripts/identity-handoff-manifest.cjs')
const {
  distributionMetadataFromPackager,
  installIdentityHandoffPayload
}: {
  distributionMetadataFromPackager: (context: unknown) => {
    distributionIdentity: string
    version: string
  }
  installIdentityHandoffPayload: (options: {
    resourcesDir: string
    distributionIdentity: string
    version: string
    payloadPath?: string
    expectedBaseUrl?: string
    expectedSourceCommit?: string
  }) => { installed: boolean; destination: string }
} = require('./identity-handoff-payload.cjs')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'taskwraith-handoff-package-'))
  roots.push(repoRoot)
  const resourcesDir = join(repoRoot, 'package-resources')
  const payloadPath = join(repoRoot, 'identity-handoff.json')
  mkdirSync(resourcesDir, { recursive: true })
  return { repoRoot, resourcesDir, payloadPath }
}

function preparedManifest(): Record<string, unknown> {
  const artifacts = Object.fromEntries(
    Object.entries(ARTIFACT_CONTRACT).map(([key, contract]) => [
      key,
      {
        ...contract,
        url: `https://github.com/boggspa/TaskWraith/releases/download/v0.1.0/${String(contract.fileName)}`,
        size: 1,
        sha256: 'a'.repeat(64)
      }
    ])
  )
  return baseManifest(true, artifacts, 'a'.repeat(40))
}

describe('identity handoff package payload', () => {
  it('installs a prepared payload only into the exact 1.9.9 beta package', () => {
    const { resourcesDir, payloadPath } = fixture()
    const manifest = preparedManifest()
    writeFileSync(payloadPath, JSON.stringify(manifest))

    const result = installIdentityHandoffPayload({
      resourcesDir,
      distributionIdentity: 'beta',
      version: '1.9.9',
      payloadPath,
      expectedSourceCommit: 'a'.repeat(40)
    })
    expect(result.installed).toBe(true)
    expect(JSON.parse(readFileSync(result.destination, 'utf8'))).toEqual(manifest)
  })

  it('removes the payload from the public target to avoid a self-referential hash', () => {
    const { resourcesDir } = fixture()
    const destination = join(resourcesDir, 'identity-handoff.json')
    writeFileSync(destination, 'stale')

    const result = installIdentityHandoffPayload({
      resourcesDir,
      distributionIdentity: 'release',
      version: '0.1.0'
    })
    expect(result.installed).toBe(false)
    expect(existsSync(destination)).toBe(false)
  })

  it('fails the final beta package when the payload is still a template', () => {
    const { resourcesDir, payloadPath } = fixture()
    writeFileSync(payloadPath, JSON.stringify(baseManifest(false)))
    expect(() =>
      installIdentityHandoffPayload({
        resourcesDir,
        distributionIdentity: 'beta',
        version: '1.9.9',
        payloadPath,
        expectedSourceCommit: 'a'.repeat(40)
      })
    ).toThrow(/not frozen/i)
  })

  it('fails final-beta packaging without an explicit external payload path', () => {
    const { resourcesDir } = fixture()
    expect(() =>
      installIdentityHandoffPayload({
        resourcesDir,
        distributionIdentity: 'beta',
        version: '1.9.9'
      })
    ).toThrow(/TASKWRAITH_IDENTITY_HANDOFF_PAYLOAD/)
  })

  it('fails final-beta packaging without wrapper-bound source provenance', () => {
    const { resourcesDir, payloadPath } = fixture()
    writeFileSync(payloadPath, JSON.stringify(preparedManifest()))
    expect(() =>
      installIdentityHandoffPayload({
        resourcesDir,
        distributionIdentity: 'beta',
        version: '1.9.9',
        payloadPath
      })
    ).toThrow(/TASKWRAITH_IDENTITY_HANDOFF_SOURCE_COMMIT/)
  })

  it('accepts the explicitly named throwaway rehearsal base only for rehearsal packaging', () => {
    const { resourcesDir, payloadPath } = fixture()
    const rehearsalBase =
      'https://github.com/boggspa/TaskWraith/releases/download/v0.1.0-handoff-rc.1'
    const manifest = preparedManifest() as {
      artifacts: Record<string, { url: string }>
    }
    for (const artifact of Object.values(manifest.artifacts)) {
      artifact.url = artifact.url.replace(
        'https://github.com/boggspa/TaskWraith/releases/download/v0.1.0',
        rehearsalBase
      )
    }
    writeFileSync(payloadPath, JSON.stringify(manifest))
    expect(
      installIdentityHandoffPayload({
        resourcesDir,
        distributionIdentity: 'beta',
        version: '1.9.9',
        payloadPath,
        expectedBaseUrl: rehearsalBase,
        expectedSourceCommit: 'a'.repeat(40)
      }).installed
    ).toBe(true)
  })

  it('reads the effective extraMetadata and appInfo version from electron-builder', () => {
    expect(
      distributionMetadataFromPackager({
        packager: {
          config: { extraMetadata: { taskwraithDistributionIdentity: 'release' } },
          appInfo: { version: '0.1.0' }
        }
      })
    ).toEqual({ distributionIdentity: 'release', version: '0.1.0' })
  })
})
