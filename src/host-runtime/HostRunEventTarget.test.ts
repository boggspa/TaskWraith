import { describe, expect, it } from 'vitest'

import type { HostRunDispatchEvent, HostRunEventTarget } from './HostRunEventTarget'

function acceptedByHostDispatchBoundary(event: HostRunDispatchEvent): HostRunEventTarget {
  return event.sender
}

describe('HostRunDispatchEvent', () => {
  it('accepts a Node-host target without desktop IPC fields', () => {
    const sender = { id: 'host-client-42' } satisfies HostRunEventTarget
    const event = { sender } satisfies HostRunDispatchEvent

    expect(acceptedByHostDispatchBoundary(event)).toBe(sender)
  })
})
