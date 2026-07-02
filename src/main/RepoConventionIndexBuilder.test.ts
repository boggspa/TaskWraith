import { describe, expect, it } from 'vitest'
import { buildRepoConventionIndexSnapshot } from './RepoConventionIndexBuilder'

const NOW = new Date('2026-07-02T22:00:00.000Z')

describe('RepoConventionIndexBuilder', () => {
  it('detects tooling, tests, style systems, boundaries, generated paths, and do-not-repeat rules', () => {
    const snapshot = buildRepoConventionIndexSnapshot({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      now: NOW,
      files: [
        'package.json',
        'pnpm-lock.yaml',
        'src/main/index.ts',
        'src/preload/index.ts',
        'src/renderer/src/App.tsx',
        'src/renderer/src/components/Button.tsx',
        'src/renderer/src/assets/css/theme.css',
        'src/main/Foo.test.ts',
        'ios/TaskWraithKit/Package.swift',
        'ios/TaskWraithKit/Sources/TaskWraithUI/HomeListViews.swift',
        'node_modules',
        'dist/app.js'
      ]
    })

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      generatedAt: NOW.toISOString()
    })
    const ids = snapshot.entries.map((entry) => entry.id)
    expect(ids).toContain('package-manager-node')
    expect(ids).toContain('package-manager-swift')
    expect(ids).toContain('component-family-react')
    expect(ids).toContain('component-family-swiftui')
    expect(ids).toContain('architectural-boundary-electron')
    expect(ids).toContain('test-convention-nearby')
    expect(ids).toContain('style-system-existing-assets')
    expect(ids).toContain('generated-paths-avoid-editing')
    expect(ids).toContain('do-not-repeat-placeholder-completion')
    expect(ids).toContain('do-not-repeat-parallel-abstractions')
    expect(
      snapshot.entries.find((entry) => entry.id === 'style-system-existing-assets')?.evidenceRefs
    ).toEqual([{ path: 'src/renderer/src/assets/css/theme.css' }])
  })

  it('rejects missing workspace ids', () => {
    expect(() =>
      buildRepoConventionIndexSnapshot({ workspaceId: ' ', files: [], now: NOW })
    ).toThrow('Repo convention index requires a workspace id.')
  })
})
