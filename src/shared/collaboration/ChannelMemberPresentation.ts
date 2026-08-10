export const MAX_CHANNEL_MEMBER_SEAT_ORDER = 4_096
export const MAX_CHANNEL_MEMBER_COLOR_INDEX = 7

export interface ChannelMemberPresentation {
  seatOrder?: number
  colorIndex?: number
  /** Host-private presentation mute. It is never part of the member wire projection. */
  seatDisabled?: boolean
}

export type ChannelMemberPublicPresentation = Omit<ChannelMemberPresentation, 'seatDisabled'>

const PRESENTATION_KEYS = new Set(['seatOrder', 'colorIndex', 'seatDisabled'])

export function isChannelMemberPresentation(
  value: unknown,
  options: { allowSeatDisabled: boolean }
): value is ChannelMemberPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.length === 0 || keys.some((key) => !PRESENTATION_KEYS.has(key))) return false
  if (
    Object.hasOwn(raw, 'seatOrder') &&
    (typeof raw.seatOrder !== 'number' ||
      !Number.isInteger(raw.seatOrder) ||
      (raw.seatOrder as number) < 0 ||
      (raw.seatOrder as number) > MAX_CHANNEL_MEMBER_SEAT_ORDER)
  ) {
    return false
  }
  if (
    Object.hasOwn(raw, 'colorIndex') &&
    (typeof raw.colorIndex !== 'number' ||
      !Number.isInteger(raw.colorIndex) ||
      (raw.colorIndex as number) < 0 ||
      (raw.colorIndex as number) > MAX_CHANNEL_MEMBER_COLOR_INDEX)
  ) {
    return false
  }
  if (Object.hasOwn(raw, 'seatDisabled')) {
    if (!options.allowSeatDisabled || typeof raw.seatDisabled !== 'boolean') return false
  }
  return true
}

export function copyChannelMemberPresentation(
  value: ChannelMemberPresentation
): ChannelMemberPresentation {
  return {
    ...(value.seatOrder === undefined ? {} : { seatOrder: value.seatOrder }),
    ...(value.colorIndex === undefined ? {} : { colorIndex: value.colorIndex }),
    ...(value.seatDisabled === undefined ? {} : { seatDisabled: value.seatDisabled })
  }
}

export function channelMemberPublicPresentation(
  value: ChannelMemberPresentation | undefined
): ChannelMemberPublicPresentation | undefined {
  if (!value) return undefined
  const projected: ChannelMemberPublicPresentation = {
    ...(value.seatOrder === undefined ? {} : { seatOrder: value.seatOrder }),
    ...(value.colorIndex === undefined ? {} : { colorIndex: value.colorIndex })
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}
