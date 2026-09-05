/* eslint-disable react-hooks/refs -- This fixture exercises the production virtualizer's synchronous geometry refs. */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useTranscriptVirtualization } from '../../src/renderer/src/components/TranscriptPanel'
import type { VirtualRow } from '../../src/renderer/src/lib/TranscriptVirtualWindow'
import type { FanoutLaneSlot } from '../../src/renderer/src/lib/fanoutLanePairing'

type Control = {
  grow: (value: boolean) => void
  scroll: (top?: number, native?: boolean) => void
  element: () => HTMLDivElement
  snapshot: () => { startIndex: number; endIndex: number; measuredSpan: number }
}
const controls: Control[] = []
let commits = 0
document.documentElement.dataset.fanoutLaneLayout = 'paired'
const style = document.createElement('style')
style.textContent = `
  :root { --space-lg: 16px; --space-md: 12px; --space-sm: 6px;
    --composer-content-max-width: 850px; --chat-side-gutter: 24px;
    --composer-scroll-under-padding: 160px; --composer-reserved-height: 100px;
    --composer-bottom-gap: 20px; }
  body { margin: 0; background: #181818; color: white; font: 14px system-ui; }
  #root { display: flex; height: 960px; width: 2500px; }
  .probe-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .probe-pane .transcript-scroll { min-height: 0; }
  .probe-card { background: #234; border: 1px solid #567; box-sizing: border-box; }
`
document.head.append(style)

export function Pane({ id }: { id: number }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const [grown, setGrown] = useState(false)
  const rows = useMemo<VirtualRow[]>(
    () =>
      Array.from({ length: 120 }, (_, index) => ({
        id: `${id}-${index}`,
        rowKey: `${id}-${index}#0`,
        index,
        rowType: 'assistant',
        contentVersion: '1',
        estimatedHeight: 116,
        hasRunBoundary: false
      })),
    [id]
  )
  const fanoutLaneSlots = useMemo(
    () =>
      new Map<string, FanoutLaneSlot>(
        rows
          .filter((row) => id === 1 || (id === 2 && row.index >= 104))
          .map((row) => [row.rowKey, row.index % 2 === 0 ? 'lead' : 'trail'])
      ),
    [id, rows]
  )
  const activeLiveRowKeys = useMemo(
    () => new Set(rows.filter((row) => row.index >= 104).map((row) => row.rowKey)),
    [rows]
  )
  const virtual = useTranscriptVirtualization({
    enabled: true,
    rows,
    scrollRef,
    contentRef,
    chatId: `pane-${id}`,
    autoFollowRef,
    compactDensity: false,
    fanoutLaneSlots,
    activeLiveRowKeys
  })
  useLayoutEffect(() => {
    commits += 1
    controls[id] = {
      grow: setGrown,
      scroll: (top, native) => {
        const el = scrollRef.current!
        autoFollowRef.current = top === undefined
        el.scrollTop = top ?? el.scrollHeight
        if (!native) virtual.syncScrollPosition(el.scrollTop)
      },
      element: () => scrollRef.current!,
      snapshot: () => ({
        ...virtual.window,
        measuredSpan: virtual.heights
          .slice(virtual.window.startIndex, virtual.window.endIndex)
          .reduce((sum, value) => sum + value, 0)
      })
    }
  }, [id, virtual])
  return (
    <div className="probe-pane">
      <div className="transcript-scroll" ref={scrollRef}>
        <div className="transcript-inner transcript-virtualized" ref={contentRef}>
          <div className="vlist-spacer-top" style={{ height: virtual.window.topSpacerPx }} />
          {rows.slice(virtual.window.startIndex, virtual.window.endIndex).map((row) => (
            <div
              key={row.rowKey}
              data-vrow-id={row.rowKey}
              data-fanout-slot={fanoutLaneSlots.get(row.rowKey)}
              ref={virtual.blockRef}
              className="transcript-message-block"
            >
              <div className="probe-card" style={{ height: grown && row.index > 103 ? 620 : 100 }}>
                Pane {id}, row {row.index}
                <input aria-label={`State for ${row.rowKey}`} defaultValue="retained" />
              </div>
            </div>
          ))}
          <div
            ref={virtual.spacerBottomRef}
            className="vlist-spacer-bottom"
            style={{ height: virtual.window.bottomSpacerPx }}
          />
          <div style={{ height: 100 }}>Working…</div>
        </div>
      </div>
    </div>
  )
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() {
  for (let i = 0; i < 8; i++) await frame()
}
async function run() {
  const root = createRoot(document.getElementById('root')!)
  flushSync(() => root.render([0, 1, 2].map((id) => <Pane key={id} id={id} />)))
  await settle()
  flushSync(() => controls.forEach((pane) => pane.scroll()))
  await settle()
  const blankFrames: number[] = []
  const startCommits = commits
  // A child reveals late content; the parent's auto-follow can run before
  // ResizeObserver has delivered the new row sizes to the virtualizer.
  const retainedTailNodes = controls.map((pane, index) =>
    pane.element().querySelector(`[data-vrow-id="${index}-119#0"]`)
  )
  flushSync(() => controls.forEach((pane) => pane.grow(true)))
  flushSync(() => controls.forEach((pane) => pane.scroll()))
  for (let i = 0; i < 30; i++) {
    await frame()
    for (const [index, pane] of controls.entries()) {
      const rect = pane.element().getBoundingClientRect()
      const visible = [...pane.element().querySelectorAll('[data-vrow-id]')].some((el) => {
        const row = el.getBoundingClientRect()
        return row.bottom > rect.top && row.top < rect.bottom - 160
      })
      if (!visible) blankFrames.push(index)
    }
  }
  const growthCommits = commits - startCommits
  const retainedTails = controls.every(
    (pane, index) =>
      pane.element().querySelector(`[data-vrow-id="${index}-119#0"]`) === retainedTailNodes[index]
  )
  const pairFailures: string[] = []
  const geometryFailures: string[] = []
  const checkPairs = (stage: string) => {
    controls.forEach((pane, index) => {
      const slots = [...pane.element().querySelectorAll<HTMLElement>('[data-fanout-slot]')]
      for (let i = 0; i < slots.length; i += 2) {
        if (
          slots[i].dataset.fanoutSlot !== 'lead' ||
          slots[i + 1]?.dataset.fanoutSlot !== 'trail'
        ) {
          pairFailures.push(`${stage}: pane ${index} split pair`)
        }
      }
      const first = pane.element().querySelector<HTMLElement>('[data-vrow-id]')
      const bottom = pane.element().querySelector<HTMLElement>('.vlist-spacer-bottom')
      if (first && bottom) {
        const actual = bottom.offsetTop - first.offsetTop
        const measured = pane.snapshot().measuredSpan
        if (Math.abs(actual - measured) > 1) {
          geometryFailures.push(`${stage}: pane ${index} measured ${measured}, actual ${actual}`)
        }
      }
    })
  }
  checkPairs('grown')
  // Exercise actual CSS grid transitions within one 80px measurement bucket.
  for (const width of [800, 790, 800]) {
    controls[1].element().parentElement!.style.flex = `0 0 ${width}px`
    await settle()
    flushSync(() => controls.forEach((pane) => pane.scroll()))
    await settle()
    checkPairs(`resize-${width}`)
  }
  flushSync(() => controls.forEach((pane) => pane.grow(false)))
  await settle()
  flushSync(() => controls.forEach((pane) => pane.scroll()))
  await settle()
  checkPairs('shrunk')
  const scrollFailures: number[] = []
  for (const top of [500, 3500, 8000, 0]) {
    controls.forEach((pane) => pane.scroll(top, true))
    await settle()
    checkPairs(`scroll-${top}`)
    controls.forEach((pane, index) => {
      const rect = pane.element().getBoundingClientRect()
      if (
        ![...pane.element().querySelectorAll('[data-vrow-id]')].some((el) => {
          const row = el.getBoundingClientRect()
          return row.bottom > rect.top && row.top < rect.bottom - 160
        })
      ) {
        scrollFailures.push(index)
      }
    })
  }
  const beforeIdle = commits
  await settle()
  const idleCommits = commits - beforeIdle
  const result = {
    ok:
      blankFrames.length === 0 &&
      pairFailures.length === 0 &&
      geometryFailures.length === 0 &&
      scrollFailures.length === 0 &&
      retainedTails &&
      idleCommits === 0,
    blankFrames: blankFrames.length,
    commitsAfterGrowth: growthCommits,
    retainedTails,
    pairFailures,
    geometryFailures,
    scrollFailures,
    idleCommits,
    panes: controls.map((pane) => ({
      ...pane.snapshot(),
      mounted: pane.element().querySelectorAll('[data-vrow-id]').length
    }))
  }
  root.unmount()
  ;(window as unknown as { reportProbe: (value: unknown) => void }).reportProbe(result)
}
run().catch((error) => {
  ;(window as unknown as { reportProbe: (value: unknown) => void }).reportProbe({
    ok: false,
    error: String(error?.stack || error)
  })
})
