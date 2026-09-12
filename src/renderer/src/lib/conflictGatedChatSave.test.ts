import { describe, expect, it } from 'vitest'
import { planConflictGatedChatSave } from './conflictGatedChatSave'

describe('planConflictGatedChatSave', () => {
  it('saves the whole record when nothing conflicts and no ensemble edit is pending', () => {
    expect(planConflictGatedChatSave({ draftConflicts: [], ensembleSliceEdit: false })).toBe(
      'whole-record'
    )
  })

  it('still skips a whole-record save while a transcript conflict is outstanding', () => {
    // The guard this gate exists to keep: a conflicted clone's tail is provably
    // not canonical's, so persisting it verbatim would revert streamed rows.
    expect(
      planConflictGatedChatSave({ draftConflicts: ['messages'], ensembleSliceEdit: false })
    ).toBe('skip')
  })

  it('routes an ensemble-slice edit through the slice save even with a transcript conflict', () => {
    // The 2026-09-12 denial: streaming makes 'messages' conflicts constant, and
    // skipping here meant the panel edit was never sent — the claim settled in
    // `finally` and the next delivery reverted the user's edit.
    expect(
      planConflictGatedChatSave({ draftConflicts: ['messages'], ensembleSliceEdit: true })
    ).toBe('ensemble-slice')
  })

  it('routes an ensemble-slice edit through the slice save with no conflicts', () => {
    expect(planConflictGatedChatSave({ draftConflicts: [], ensembleSliceEdit: true })).toBe(
      'ensemble-slice'
    )
  })

  it('keeps skipping a whole-record save on non-transcript conflicts too', () => {
    expect(
      planConflictGatedChatSave({
        draftConflicts: ['persistenceRevision', 'runs.run-1.status'],
        ensembleSliceEdit: false
      })
    ).toBe('skip')
  })
})
