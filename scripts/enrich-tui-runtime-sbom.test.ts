import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  COMPONENT_PREFIX,
  enrichSbom
}: {
  COMPONENT_PREFIX: string
  enrichSbom: (
    sbom: Record<string, unknown>,
    runtimeMetadata: Record<string, unknown>,
    expectedVersion: string
  ) => {
    components: Array<Record<string, unknown>>
    dependencies: Array<{ ref: string; dependsOn: string[] }>
  }
} = require('./enrich-tui-runtime-sbom.cjs')

function target(overrides: Record<string, unknown> = {}) {
  const source = 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz'
  return {
    platform: 'darwin',
    arch: 'arm64',
    sha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    licenseSha256: 'c'.repeat(64),
    source,
    licenseSource: `${source}#LICENSE`,
    ...overrides
  }
}

describe('TUI runtime SBOM enrichment', () => {
  it('adds an archive- and license-bound CycloneDX component per runtime target', () => {
    const result = enrichSbom(
      {
        bomFormat: 'CycloneDX',
        metadata: { component: { 'bom-ref': 'taskwraith@1.9.2' } },
        components: [{ type: 'library', name: 'existing' }],
        dependencies: [{ ref: 'taskwraith@1.9.2', dependsOn: ['dependency@1'] }]
      },
      {
        nodeVersion: '22.23.2',
        targets: [target(), target({ platform: 'darwin', arch: 'x64', sha256: 'd'.repeat(64) })]
      },
      '22.23.2'
    )

    const runtimes = result.components.filter((component) =>
      String(component['bom-ref'] || '').startsWith(COMPONENT_PREFIX)
    )
    expect(runtimes).toHaveLength(2)
    expect(runtimes[0]).toMatchObject({
      name: 'Node.js standalone TUI runtime',
      version: '22.23.2',
      hashes: [{ alg: 'SHA-256', content: 'a'.repeat(64) }],
      licenses: [{ license: { id: 'MIT' } }]
    })
    expect(JSON.stringify(runtimes[0])).toContain('taskwraith:tui-runtime:license-sha256')
    const runtimeRefs = runtimes.map((component) => component['bom-ref'])
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        {
          ref: 'taskwraith@1.9.2',
          dependsOn: expect.arrayContaining(['dependency@1', ...runtimeRefs])
        },
        { ref: runtimeRefs[0], dependsOn: [] },
        { ref: runtimeRefs[1], dependsOn: [] }
      ])
    )
  })

  it('fails closed on policy drift, duplicate targets, or invalid license binding', () => {
    const sbom = { bomFormat: 'CycloneDX', components: [] }
    expect(() =>
      enrichSbom(sbom, { nodeVersion: '22.23.1', targets: [target()] }, '22.23.2')
    ).toThrow('does not match package policy')
    expect(() =>
      enrichSbom(sbom, { nodeVersion: '22.23.2', targets: [target(), target()] }, '22.23.2')
    ).toThrow('duplicate')
    expect(() =>
      enrichSbom(
        sbom,
        {
          nodeVersion: '22.23.2',
          targets: [target({ licenseSource: 'https://nodejs.org/LICENSE' })]
        },
        '22.23.2'
      )
    ).toThrow('license source')
  })

  it('rejects a malformed CycloneDX dependency graph', () => {
    expect(() =>
      enrichSbom(
        { bomFormat: 'CycloneDX', components: [] },
        { nodeVersion: '22.23.2', targets: [target()] },
        '22.23.2'
      )
    ).toThrow('missing its root component or dependencies array')

    expect(() =>
      enrichSbom(
        {
          bomFormat: 'CycloneDX',
          metadata: { component: { 'bom-ref': 'taskwraith@1.9.2' } },
          components: [],
          dependencies: [
            { ref: 'taskwraith@1.9.2', dependsOn: [] },
            { ref: 'taskwraith@1.9.2', dependsOn: [] }
          ]
        },
        { nodeVersion: '22.23.2', targets: [target()] },
        '22.23.2'
      )
    ).toThrow('duplicate ref')
  })
})
