/** Keep normal two-pass layout synchronous, then yield a long page's remaining
 * measurement work. Newly mounted rows can introduce more keys on every pass;
 * their convergence budget must not bypass React's nested-update limit. */
export function createTranscriptMeasureScheduler({
  bump,
  requestFrame,
  cancelFrame
}: {
  bump: () => void
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
}) {
  let synchronousPasses = 0
  let frame: number | null = null

  const reset = (): void => {
    if (frame !== null) cancelFrame(frame)
    frame = null
    synchronousPasses = 0
  }

  return {
    reset,
    request(): void {
      if (frame !== null) return
      if (synchronousPasses < 2) {
        synchronousPasses++
        bump()
        return
      }
      frame = requestFrame(() => {
        frame = null
        synchronousPasses = 0
        bump()
      })
    }
  }
}
