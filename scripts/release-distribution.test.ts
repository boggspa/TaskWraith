import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { deepAssign } = require('builder-util-runtime') as {
  deepAssign: (target: unknown, ...sources: unknown[]) => Record<string, unknown>
}
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config') as {
  doMergeConfigs: (configs: Record<string, unknown>[]) => Record<string, unknown>
}
const yaml = require('js-yaml') as { load: (text: string) => Record<string, unknown> }
const {
  DEBUT_BUILDER_CONFIG,
  HANDOFF_CONTRACT_FILE,
  RELEASE_BUILDER_CONFIG,
  ROOT_BUILDER_CONFIG,
  findChangelogRelease,
  loadBuilderIdentity,
  resolveReleaseDistribution,
  resolveUpdateFeedChannel
}: {
  DEBUT_BUILDER_CONFIG: string
  HANDOFF_CONTRACT_FILE: string
  RELEASE_BUILDER_CONFIG: string
  ROOT_BUILDER_CONFIG: string
  findChangelogRelease: (
    changelogText: string,
    version: string
  ) => { version: string; date?: string } | null
  loadBuilderIdentity: (
    repoRoot: string,
    configFile: string
  ) => {
    configFile: string
    config: Record<string, unknown>
    appId: string | null
    distributionIdentity: string | null
    updateFeedChannel: string | null
    version: string | null
    publishChannel: string | null
  }
  resolveReleaseDistribution: (options: { repoRoot?: string; distribution?: string }) => {
    distribution: string
    version: string
    sourceVersion: string
    appId: string | null
    distributionIdentity: string | null
    updateFeedChannel: string | null
    publishChannel: string | null
    config: Record<string, unknown>
    prerelease: boolean
    feedChannel: string
    builderConfig: string
  }
  resolveUpdateFeedChannel: (
    version: string,
    options?: { distribution?: string; channelOverride?: string; updateFeedChannel?: string }
  ) => string
} = require('./release-distribution.cjs')

const REPO_ROOT = process.cwd()

const HANDOFF_CONTRACT = {
  schemaVersion: 1,
  handoffId: 'taskwraith-1.9.9-to-0.1.0-v1',
  prepared: false,
  sourceCommit: null,
  source: {
    distributionIdentity: 'beta',
    appId: 'com.chrisizatt.taskwraith',
    version: '1.9.9',
    updateFeedChannel: 'latest'
  },
  target: {
    distributionIdentity: 'release',
    appId: 'com.taskwraith.desktop',
    version: '0.1.0',
    updateFeedChannel: 'release'
  },
  supportUrl: 'https://github.com/boggspa/TaskWraith/releases/tag/v0.1.0',
  artifacts: {}
}

const BETA_BUILDER_YAML = [
  'appId: com.chrisizatt.taskwraith',
  'extraMetadata:',
  '  taskwraithDistributionIdentity: beta',
  '  taskwraithAppId: com.chrisizatt.taskwraith',
  '  taskwraithUpdateFeedChannel: latest',
  ''
].join('\n')

function makeFixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-release-distribution-'))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

function fixtureRepo({
  version = '1.9.9',
  packageExtra = '',
  contract = HANDOFF_CONTRACT as unknown as Record<string, unknown> | null,
  overrides = {}
}: {
  version?: string
  packageExtra?: string
  contract?: Record<string, unknown> | null
  overrides?: Record<string, string>
} = {}) {
  const files: Record<string, string> = {
    'package.json': `{"name":"taskwraith","version":"${version}"${packageExtra}}`,
    [ROOT_BUILDER_CONFIG]: BETA_BUILDER_YAML,
    ...overrides
  }
  if (contract) files[HANDOFF_CONTRACT_FILE] = JSON.stringify(contract)
  return makeFixture(files)
}

describe('release-distribution helper', () => {
  describe('resolveReleaseDistribution on the real repository root', () => {
    it('uses the declared epoch and the matching builder config', () => {
      const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
      const distribution = packageJson.taskwraithRelease?.distribution || 'beta'
      const resolved = resolveReleaseDistribution({ repoRoot: REPO_ROOT })
      expect(resolved.distribution).toBe(distribution)
      expect(resolved.version).toBe(packageJson.version)
      expect(resolved.sourceVersion).toBe(packageJson.version)
      expect(resolved.builderConfig).toBe(
        distribution === 'beta' ? ROOT_BUILDER_CONFIG : RELEASE_BUILDER_CONFIG
      )
      expect(resolved.updateFeedChannel).toBe(distribution === 'beta' ? 'latest' : 'release')
      expect(resolved.feedChannel).toBe(resolved.updateFeedChannel)
      expect(resolved.prerelease).toBe(false)
    })

    it('admits the debut only at its frozen source version, including after the release bump', () => {
      const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
      const contract = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, HANDOFF_CONTRACT_FILE), 'utf8')
      )
      const resolveDebut = () =>
        resolveReleaseDistribution({ repoRoot: REPO_ROOT, distribution: 'debut' })
      if (packageJson.version === contract.source.version) {
        expect(resolveDebut()).toMatchObject({
          sourceVersion: contract.source.version,
          version: contract.target.version,
          distribution: 'debut'
        })
      } else {
        expect(resolveDebut).toThrow(/debut source drift:/)
      }
    })
  })

  describe('epoch selection', () => {
    it('reads the declared root distribution from package.json', () => {
      const repoRoot = fixtureRepo({
        packageExtra: ',"taskwraithRelease":{"distribution":"release"}',
        overrides: {
          [RELEASE_BUILDER_CONFIG]: [
            'appId: com.taskwraith.desktop',
            'extraMetadata:',
            '  taskwraithDistributionIdentity: release',
            '  taskwraithUpdateFeedChannel: release',
            ''
          ].join('\n')
        }
      })
      const resolved = resolveReleaseDistribution({ repoRoot })
      expect(resolved.distribution).toBe('release')
      expect(resolved.version).toBe('1.9.9')
      expect(resolved.builderConfig).toBe(RELEASE_BUILDER_CONFIG)
      expect(resolved.feedChannel).toBe('release')
    })

    it('explicit debut overrides a beta root declaration', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.yml',
            'extraMetadata:',
            '  version: 0.1.0',
            ''
          ].join('\n')
        }
      })
      const resolved = resolveReleaseDistribution({ repoRoot, distribution: 'debut' })
      expect(resolved.distribution).toBe('debut')
      expect(resolved.version).toBe('0.1.0')
      expect(resolved.builderConfig).toBe(DEBUT_BUILDER_CONFIG)
    })

    it('rejects a root declaration outside beta/release', () => {
      const repoRoot = fixtureRepo({
        packageExtra: ',"taskwraithRelease":{"distribution":"debut"}'
      })
      expect(() => resolveReleaseDistribution({ repoRoot })).toThrow(
        /taskwraithRelease\.distribution must be beta or release/
      )
    })

    it('rejects an explicit distribution outside the known set', () => {
      const repoRoot = fixtureRepo()
      expect(() => resolveReleaseDistribution({ repoRoot, distribution: 'nightly' })).toThrow(
        /unsupported release distribution/
      )
    })

    it('requires the release builder config for the release distribution', () => {
      const repoRoot = fixtureRepo()
      expect(() => resolveReleaseDistribution({ repoRoot, distribution: 'release' })).toThrow(
        new RegExp(RELEASE_BUILDER_CONFIG.replace('.', '\\.'))
      )
    })

    it('falls back to beta for legacy fixtures without the declared field', () => {
      const repoRoot = fixtureRepo()
      const resolved = resolveReleaseDistribution({ repoRoot })
      expect(resolved.distribution).toBe('beta')
      expect(resolved.builderConfig).toBe(ROOT_BUILDER_CONFIG)
    })

    it('keeps a later public 1.x on the release identity', () => {
      const repoRoot = fixtureRepo({
        version: '1.0.0',
        packageExtra: ',"taskwraithRelease":{"distribution":"release"}',
        overrides: {
          [RELEASE_BUILDER_CONFIG]: [
            'appId: com.taskwraith.desktop',
            'extraMetadata:',
            '  taskwraithDistributionIdentity: release',
            '  taskwraithUpdateFeedChannel: release',
            ''
          ].join('\n')
        }
      })
      const resolved = resolveReleaseDistribution({ repoRoot })
      expect(resolved.distribution).toBe('release')
      expect(resolved.version).toBe('1.0.0')
      expect(resolved.builderConfig).toBe(RELEASE_BUILDER_CONFIG)
      expect(resolved.feedChannel).toBe('release')
      expect(resolveUpdateFeedChannel('1.0.0', { distribution: 'release' })).toBe('release')
    })
  })

  describe('frozen debut contract', () => {
    const DEBUT_YAML = [
      'extends: electron-builder.yml',
      'extraMetadata:',
      '  version: 0.1.0',
      ''
    ].join('\n')

    it('accepts a debut that matches the frozen source and target pins', () => {
      const repoRoot = fixtureRepo({ overrides: { [DEBUT_BUILDER_CONFIG]: DEBUT_YAML } })
      const resolved = resolveReleaseDistribution({ repoRoot, distribution: 'debut' })
      expect(resolved.version).toBe('0.1.0')
      expect(resolved.sourceVersion).toBe('1.9.9')
    })

    it('rejects a debut cut from the wrong source version', () => {
      const repoRoot = fixtureRepo({
        version: '1.9.8',
        overrides: { [DEBUT_BUILDER_CONFIG]: DEBUT_YAML }
      })
      expect(() => resolveReleaseDistribution({ repoRoot, distribution: 'debut' })).toThrow(
        /debut source drift: package\.json is 1\.9\.8 but the frozen handoff contract pins source 1\.9\.9/
      )
    })

    it('rejects a debut config that drifts from the frozen target version', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.yml',
            'extraMetadata:',
            '  version: 0.1.1',
            ''
          ].join('\n')
        }
      })
      expect(() => resolveReleaseDistribution({ repoRoot, distribution: 'debut' })).toThrow(
        /debut target drift: .* declares 0\.1\.1 but the frozen handoff contract pins target 0\.1\.0/
      )
    })

    it('requires the tracked contract template to exist', () => {
      const repoRoot = fixtureRepo({
        contract: null,
        overrides: { [DEBUT_BUILDER_CONFIG]: DEBUT_YAML }
      })
      expect(() => resolveReleaseDistribution({ repoRoot, distribution: 'debut' })).toThrow(
        /requires the tracked identity-handoff contract/
      )
    })

    it('refuses a prepared payload in place of the template', () => {
      const repoRoot = fixtureRepo({
        contract: { ...HANDOFF_CONTRACT, prepared: true },
        overrides: { [DEBUT_BUILDER_CONFIG]: DEBUT_YAML }
      })
      expect(() => resolveReleaseDistribution({ repoRoot, distribution: 'debut' })).toThrow(
        /must be the unprepared contract template/
      )
    })
  })

  describe('builder identity resolution', () => {
    it('follows a declared extends chain and merges extraMetadata', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [RELEASE_BUILDER_CONFIG]: [
            'appId: com.taskwraith.desktop',
            'extraMetadata:',
            '  taskwraithDistributionIdentity: release',
            '  taskwraithUpdateFeedChannel: release',
            'publish:',
            '  provider: generic',
            '  url: https://taskwraith.dev/updates/release/',
            'generateUpdatesFilesForAllChannels: false',
            ''
          ].join('\n'),
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.release.yml',
            'directories:',
            '  output: dist-debut',
            'extraMetadata:',
            '  version: 0.1.0',
            ''
          ].join('\n')
        }
      })
      const identity = loadBuilderIdentity(repoRoot, DEBUT_BUILDER_CONFIG)
      expect(identity.appId).toBe('com.taskwraith.desktop')
      expect(identity.distributionIdentity).toBe('release')
      expect(identity.updateFeedChannel).toBe('release')
      expect(identity.version).toBe('0.1.0')
      expect(identity.publishChannel).toBeNull()
      expect(identity.config.publish).toMatchObject({
        provider: 'generic',
        url: 'https://taskwraith.dev/updates/release/'
      })
      expect(identity.config.generateUpdatesFilesForAllChannels).toBe(false)
      expect(identity.config.directories).toMatchObject({ output: 'dist-debut' })
    })

    it('projects a one-element publish array and preserves it on the effective config', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [RELEASE_BUILDER_CONFIG]: [
            'appId: com.taskwraith.desktop',
            'extraMetadata:',
            '  taskwraithDistributionIdentity: release',
            '  taskwraithUpdateFeedChannel: release',
            'publish:',
            '  - provider: generic',
            '    url: https://taskwraith.dev/updates/release/',
            '    channel: release',
            ''
          ].join('\n'),
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.release.yml',
            'extraMetadata:',
            '  version: 0.1.0',
            ''
          ].join('\n')
        }
      })
      const identity = loadBuilderIdentity(repoRoot, DEBUT_BUILDER_CONFIG)
      expect(identity.publishChannel).toBe('release')
      expect(Array.isArray(identity.config.publish)).toBe(true)
      expect(identity.config.publish).toHaveLength(1)
      expect((identity.config.publish as unknown[])[0]).toMatchObject({
        provider: 'generic',
        channel: 'release'
      })
    })

    it('rejects an effective publish array with more than one provider', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.yml',
            'publish:',
            '  - provider: generic',
            '    url: https://taskwraith.dev/updates/release/',
            '  - provider: github',
            '    repo: TaskWraith',
            'extraMetadata:',
            '  version: 0.1.0',
            ''
          ].join('\n')
        }
      })
      expect(() => loadBuilderIdentity(repoRoot, DEBUT_BUILDER_CONFIG)).toThrow(
        /exactly one is supported/
      )
    })

    it('merges with the same semantics as electron-builder deepAssign', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [RELEASE_BUILDER_CONFIG]: [
            'appId: com.taskwraith.desktop',
            'electronLanguages:',
            '  - en',
            '  - de',
            'extraMetadata:',
            '  taskwraithDistributionIdentity: release',
            '  taskwraithUpdateFeedChannel: release',
            'nested:',
            '  keep: base',
            '  override: base',
            ''
          ].join('\n'),
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.release.yml',
            'electronLanguages:',
            '  - de',
            '  - fr',
            'extraMetadata:',
            '  version: 0.1.0',
            'nested:',
            '  override: child',
            '  added: child',
            ''
          ].join('\n')
        }
      })
      const base = yaml.load(fs.readFileSync(path.join(repoRoot, RELEASE_BUILDER_CONFIG), 'utf8'))
      const child = yaml.load(fs.readFileSync(path.join(repoRoot, DEBUT_BUILDER_CONFIG), 'utf8'))
      const reference = deepAssign({}, base, child)
      expect(loadBuilderIdentity(repoRoot, DEBUT_BUILDER_CONFIG).config).toEqual(reference)
      // Arrays concatenate with deduplication, child scalars win, nested maps
      // merge deeply — exactly what electron-builder computes.
      expect(reference.electronLanguages).toEqual(['en', 'de', 'fr'])
      expect(reference.nested).toEqual({ keep: 'base', override: 'child', added: 'child' })
    })

    it('projects the same identity fields as app-builder-lib doMergeConfigs', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [RELEASE_BUILDER_CONFIG]: [
            'appId: com.taskwraith.desktop',
            'extraMetadata:',
            '  taskwraithDistributionIdentity: release',
            '  taskwraithUpdateFeedChannel: release',
            'publish:',
            '  - provider: generic',
            '    url: https://taskwraith.dev/updates/release/',
            '    channel: release',
            'generateUpdatesFilesForAllChannels: false',
            ''
          ].join('\n'),
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.release.yml',
            'extraMetadata:',
            '  version: 0.1.0',
            ''
          ].join('\n')
        }
      })
      const base = yaml.load(fs.readFileSync(path.join(repoRoot, RELEASE_BUILDER_CONFIG), 'utf8'))
      const child = yaml.load(fs.readFileSync(path.join(repoRoot, DEBUT_BUILDER_CONFIG), 'utf8'))
      // The real builder merge also normalizes files and injects directory
      // defaults, so parity is asserted on the fields consumers read.
      const builderMerged = doMergeConfigs([base, child])
      const identity = loadBuilderIdentity(repoRoot, DEBUT_BUILDER_CONFIG)
      for (const key of [
        'appId',
        'extraMetadata',
        'publish',
        'generateUpdatesFilesForAllChannels'
      ] as const) {
        expect(identity.config[key]).toEqual(builderMerged[key])
      }
    })

    it('rejects extends cycles', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          'electron-builder.a.yml': 'extends: electron-builder.b.yml\n',
          'electron-builder.b.yml': 'extends: electron-builder.a.yml\n'
        }
      })
      expect(() => loadBuilderIdentity(repoRoot, 'electron-builder.a.yml')).toThrow(/extends cycle/)
    })

    it('rejects unbounded extends chains', () => {
      const overrides: Record<string, string> = {}
      for (let index = 0; index < 6; index += 1) {
        overrides[`chain-${index}.yml`] = `extends: chain-${index + 1}.yml\n`
      }
      overrides['chain-6.yml'] = 'appId: com.example\n'
      const repoRoot = fixtureRepo({ overrides })
      expect(() => loadBuilderIdentity(repoRoot, 'chain-0.yml')).toThrow(/extends chain exceeds/)
    })

    it('treats a root builder version that disagrees with package.json as drift', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [ROOT_BUILDER_CONFIG]: [
            'appId: com.chrisizatt.taskwraith',
            'extraMetadata:',
            '  taskwraithUpdateFeedChannel: latest',
            '  version: 1.9.8',
            ''
          ].join('\n')
        }
      })
      expect(() => resolveReleaseDistribution({ repoRoot })).toThrow(/does not match package\.json/)
    })

    it('rejects a prerelease debut target', () => {
      const repoRoot = fixtureRepo({
        overrides: {
          [DEBUT_BUILDER_CONFIG]: [
            'extends: electron-builder.yml',
            'extraMetadata:',
            '  version: 0.1.0-beta.1',
            ''
          ].join('\n')
        }
      })
      expect(() => resolveReleaseDistribution({ repoRoot, distribution: 'debut' })).toThrow(
        /requires a stable target version/
      )
    })
  })

  describe('resolveUpdateFeedChannel', () => {
    it('lets an explicit channel override win for every version shape', () => {
      expect(
        resolveUpdateFeedChannel('1.9.9', { distribution: 'beta', channelOverride: 'release' })
      ).toBe('release')
      expect(resolveUpdateFeedChannel('0.1.0', { channelOverride: 'latest' })).toBe('latest')
    })

    it('keeps prereleases on the beta channel regardless of distribution', () => {
      expect(resolveUpdateFeedChannel('1.9.9-beta.1', { distribution: 'release' })).toBe('beta')
      expect(resolveUpdateFeedChannel('0.1.1-beta.2', { distribution: 'release' })).toBe('beta')
    })

    it('defaults stable versions to the distribution epoch channel', () => {
      expect(resolveUpdateFeedChannel('1.9.9')).toBe('latest')
      expect(resolveUpdateFeedChannel('1.9.9', { distribution: 'beta' })).toBe('latest')
      expect(resolveUpdateFeedChannel('0.1.0', { distribution: 'release' })).toBe('release')
      expect(resolveUpdateFeedChannel('0.1.0', { distribution: 'debut' })).toBe('release')
    })

    it('prefers the identity-declared channel over the distribution default', () => {
      expect(
        resolveUpdateFeedChannel('1.9.9', { distribution: 'beta', updateFeedChannel: 'latest' })
      ).toBe('latest')
      expect(
        resolveUpdateFeedChannel('9.9.9', { distribution: 'release', updateFeedChannel: 'release' })
      ).toBe('release')
    })

    it('rejects unknown distributions instead of silently mapping them to release', () => {
      expect(() => resolveUpdateFeedChannel('1.9.9', { distribution: 'nightly' })).toThrow(
        /unsupported release distribution/
      )
      // Even a prerelease version must not bypass distribution validation.
      expect(() => resolveUpdateFeedChannel('1.9.9-beta.1', { distribution: 'nightly' })).toThrow(
        /unsupported release distribution/
      )
    })
  })

  describe('findChangelogRelease', () => {
    const changelog =
      '# Changelog\n\n## Unreleased\n\n- Wip.\n\n## 1.9.9 - 2026-10-08\n\n- Beta.\n\n## 0.1.0 - 2026-10-08\n\n- Debut.\n'

    it('finds a dated section below the top release', () => {
      expect(findChangelogRelease(changelog, '0.1.0')).toEqual({
        version: '0.1.0',
        date: '2026-10-08'
      })
    })

    it('finds an undated section and reports the missing date', () => {
      expect(findChangelogRelease('# Changelog\n\n## 0.1.0\n\n- Debut.\n', '0.1.0')).toEqual({
        version: '0.1.0',
        date: undefined
      })
    })

    it('rejects missing sections and substring lookalikes', () => {
      expect(findChangelogRelease(changelog, '0.1.1')).toBeNull()
      expect(findChangelogRelease('## 10.1.00 - 2026-10-08\n\n- Wrong.\n', '0.1.0')).toBeNull()
    })
  })
})
