export function journalPreparationEnrollment(
  env: Readonly<Record<string, string | undefined>>,
  journalFlusherAttached: boolean
) {
  const maintenance = env.TASKWRAITH_CHECKPOINT_WORKER === '1'
  const rotation =
    env.TASKWRAITH_JOURNAL_ROTATION === '1' &&
    env.TASKWRAITH_JOURNAL_FLUSHER === '1' &&
    journalFlusherAttached
  const publication = env.TASKWRAITH_CHECKPOINT_PUBLICATION === '1' && maintenance && rotation
  return { maintenance, rotation, publication }
}
