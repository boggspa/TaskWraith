/**
 * Gate a state dispatch with an authoritative ref that is updated before the
 * dispatch. This is stronger than relying on React's eager same-value bailout:
 * that bailout is unavailable while the fiber tree still has pending sync work.
 */
export function setRefStateIfChanged<T>(
  stateRef: { current: T },
  next: T,
  setState: (value: T) => void
): boolean {
  if (stateRef.current === next) return false
  stateRef.current = next
  setState(next)
  return true
}
