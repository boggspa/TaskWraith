import { describe, expect, it } from 'vitest'
import { journalPreparationEnrollment } from './JournalPreparationEnrollment'

describe('ratified journal preparation enrollment', () => {
  it('preserves worker-only maintenance and defaults new paths off', () => {
    expect(journalPreparationEnrollment({}, true)).toEqual({
      maintenance: false,
      rotation: false,
      publication: false
    })
    expect(journalPreparationEnrollment({ TASKWRAITH_CHECKPOINT_WORKER: '1' }, true)).toEqual({
      maintenance: true,
      rotation: false,
      publication: false
    })
  })
  it('requires exact flags and an attached flusher for publication', () => {
    const env = {
      TASKWRAITH_CHECKPOINT_WORKER: '1',
      TASKWRAITH_JOURNAL_ROTATION: '1',
      TASKWRAITH_JOURNAL_FLUSHER: '1',
      TASKWRAITH_CHECKPOINT_PUBLICATION: '1'
    }
    expect(journalPreparationEnrollment(env, true).publication).toBe(true)
    expect(journalPreparationEnrollment(env, false).publication).toBe(false)
    for (const key of Object.keys(env))
      expect(journalPreparationEnrollment({ ...env, [key]: 'true' }, true).publication).toBe(false)
  })
})
