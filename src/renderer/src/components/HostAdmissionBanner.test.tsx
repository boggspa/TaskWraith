import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  admitToPendingStack,
  HostAdmissionBannerCard,
  hostAdmissionRejectAriaLabel,
  toPendingAdmission
} from './HostAdmissionBanner'

describe('HostAdmissionBanner', () => {
  it('builds a descriptive reject label from the collaborator name', () => {
    expect(hostAdmissionRejectAriaLabel('Alex')).toBe(
      "Reject Alex's join attempt and stop sharing"
    )
  })

  it('renders the reject button with the descriptive aria-label', () => {
    const html = renderToStaticMarkup(
      <HostAdmissionBannerCard
        entry={{
          handshakeId: 'hs-1',
          shareId: 'share-1',
          displayName: 'Alex',
          confirmCode: '123456',
          mode: 'admission'
        }}
        onReject={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(html).toContain('aria-label="Reject Alex&#x27;s join attempt and stop sharing"')
    expect(html).toContain('aria-label="Security code 123456"')
    expect(html).toContain('123456')
  })

  it('renders a reconnect as an informational notice: no SAS code, no Reject', () => {
    const html = renderToStaticMarkup(
      <HostAdmissionBannerCard
        entry={{
          handshakeId: 'hs-2',
          shareId: 'share-1',
          displayName: 'Alex',
          confirmCode: '654321',
          mode: 'reconnect'
        }}
        onReject={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(html).toContain('reconnecting to this People chat')
    expect(html).not.toContain('654321')
    expect(html).not.toContain('Reject')
    expect(html).toContain('aria-label="Dismiss"')
  })

  it('never lets a non-string name reach the card', () => {
    // The payload comes off the wire. `payload.displayName || fallback` lets any
    // truthy non-string through, and React throws on a plain-object child —
    // there is no boundary between this banner and the root one, so that blanks
    // the host's whole window until they reload.
    const entry = toPendingAdmission({
      handshakeId: 'hs-1',
      shareId: 'share-1',
      displayName: { evil: true },
      confirmCode: '123456',
      mode: 'admission'
    })
    expect(entry.displayName).toBe('A collaborator')
    expect(() =>
      renderToStaticMarkup(
        <HostAdmissionBannerCard entry={entry} onReject={() => {}} onDismiss={() => {}} />
      )
    ).not.toThrow()
  })

  it('bounds the card stack, reporting what it dropped so timers can be cleared', () => {
    // handshakeId is a fresh uuid per begin, so the same-id filter never removes
    // anything: without a cap the stack grows for as long as a producer keeps
    // beginning, and every card carries its own expiry timer.
    const card = (n: number) =>
      toPendingAdmission({
        handshakeId: `hs-${n}`,
        shareId: 'share-1',
        displayName: `Person ${n}`,
        confirmCode: '123456',
        mode: 'admission'
      })
    let stack = [card(0)]
    const droppedIds: string[] = []
    for (let n = 1; n < 20; n += 1) {
      const result = admitToPendingStack(stack, card(n))
      stack = result.next
      droppedIds.push(...result.dropped.map((entry) => entry.handshakeId))
    }
    expect(stack).toHaveLength(5)
    // Newest wins — the host sees who is knocking NOW.
    expect(stack.map((entry) => entry.handshakeId)).toEqual([
      'hs-15',
      'hs-16',
      'hs-17',
      'hs-18',
      'hs-19'
    ])
    // Every evicted card is reported exactly once, or its timer leaks.
    expect(droppedIds).toEqual(Array.from({ length: 15 }, (_, i) => `hs-${i}`))
  })

  it('re-admitting the same handshake replaces rather than stacks', () => {
    const entry = toPendingAdmission({
      handshakeId: 'hs-1',
      shareId: 'share-1',
      displayName: 'Alex',
      confirmCode: '123456',
      mode: 'admission'
    })
    const { next, dropped } = admitToPendingStack([entry], { ...entry, confirmCode: '654321' })
    expect(next).toHaveLength(1)
    expect(next[0].confirmCode).toBe('654321')
    expect(dropped).toEqual([])
  })
})
