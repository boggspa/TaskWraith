import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isRuntimeMarkerName, RUNTIME_MARKER_NAME_RE } from './RuntimeMarkerPattern'

const WORK_LOCKS_DIR = join(__dirname)

/**
 * Landmine pin: the runtime marker shape must have exactly one owner.
 * If either consumer reintroduces a local copy of the regex, recognition can
 * diverge silently when only one site is updated.
 */
describe('RuntimeMarkerPattern lockstep', () => {
  const rawPatternSource =
    '/^\\.WORK-IN-PROGRESS-taskwraith-runtime-[A-Za-z0-9_-]+-[a-f0-9]{64}\\.md$/'

  it('accepts the canonical runtime marker filename shape', () => {
    const name = `.WORK-IN-PROGRESS-taskwraith-runtime-desktop-a-${'a'.repeat(64)}.md`
    expect(isRuntimeMarkerName(name)).toBe(true)
    expect(RUNTIME_MARKER_NAME_RE.test(name)).toBe(true)
  })

  it('rejects human WIP markers and malformed runtime names', () => {
    expect(isRuntimeMarkerName('.WORK-IN-PROGRESS-my-feature.md')).toBe(false)
    expect(isRuntimeMarkerName(`.WORK-IN-PROGRESS-taskwraith-runtime-x-${'a'.repeat(63)}.md`)).toBe(
      false
    )
    expect(isRuntimeMarkerName(`.WORK-IN-PROGRESS-taskwraith-runtime-x-${'g'.repeat(64)}.md`)).toBe(
      false
    )
  })

  it('pins both consumers to the shared module (fails if only one site is updated)', () => {
    const persistence = readFileSync(
      join(WORK_LOCKS_DIR, 'NodeWorkspaceLockPersistence.ts'),
      'utf8'
    )
    const wal = readFileSync(join(WORK_LOCKS_DIR, 'WorkspaceLockWal.ts'), 'utf8')
    const shared = readFileSync(join(WORK_LOCKS_DIR, 'RuntimeMarkerPattern.ts'), 'utf8')

    // Shared module is the sole owner of the raw regex literal.
    expect(shared).toContain(rawPatternSource)

    // Neither consumer may embed its own copy of the shape regex.
    expect(persistence).not.toContain(rawPatternSource)
    expect(wal).not.toContain(rawPatternSource)

    // Both must import the shared recognition helper (or the shared regex).
    expect(persistence).toMatch(/from ['"]\.\/RuntimeMarkerPattern['"]/)
    expect(wal).toMatch(/from ['"]\.\/RuntimeMarkerPattern['"]/)
    expect(persistence).toMatch(/\bisRuntimeMarkerName\b/)
    expect(wal).toMatch(/\bisRuntimeMarkerName\b|\bRUNTIME_MARKER_NAME_RE\b/)
  })
})
