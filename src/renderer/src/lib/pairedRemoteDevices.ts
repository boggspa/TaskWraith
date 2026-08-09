export interface PairedRemoteDeviceLike {
  iphoneIdentityPubKey: string
  pairId: string
  controllerDisplayName: string
  pairedAt: string
  connected: boolean
}

/** Keep the prior array when a poll reports the same ordered device snapshot. */
export function reusePairedRemoteDevices<T extends PairedRemoteDeviceLike>(
  previous: T[],
  next: T[]
): T[] {
  if (previous.length !== next.length) return next
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]
    const right = next[index]
    if (
      left.iphoneIdentityPubKey !== right.iphoneIdentityPubKey ||
      left.pairId !== right.pairId ||
      left.controllerDisplayName !== right.controllerDisplayName ||
      left.pairedAt !== right.pairedAt ||
      left.connected !== right.connected
    ) {
      return next
    }
  }
  return previous
}
