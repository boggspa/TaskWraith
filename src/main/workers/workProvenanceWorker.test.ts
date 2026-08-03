import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { queryBundledWorkProvenance } from './workProvenanceWorker'

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

describe('workProvenanceWorker', () => {
  it('runs the bundled TaskWraith query against a repository without importing repository code', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskwraith-provenance-worker-'))
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'tests@taskwraith.local'])
    git(root, ['config', 'user.name', 'TaskWraith Tests'])
    writeFileSync(join(root, 'tracked.txt'), 'before\n')
    git(root, ['add', 'tracked.txt'])
    git(root, ['commit', '-qm', 'Initial'])
    writeFileSync(join(root, 'tracked.txt'), 'after\n')

    const projection = queryBundledWorkProvenance(root)

    expect(projection.projectionVersion).toBe(1)
    expect(projection.gitGeneration?.coherent).toBe(true)
    expect(projection.attribution.root).toMatchObject({
      files: 1,
      trackedFiles: 1,
      untrackedFiles: 0,
      additions: 1,
      deletions: 1
    })
    expect(projection.attribution.unclaimedUnknown.paths).toEqual([
      expect.objectContaining({ path: 'tracked.txt', confidence: 'unknown' })
    ])
  })
})
