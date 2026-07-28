import { composerAboveRowClearancePx, countComposerAboveRowStrips } from './composerScrollClearance'

interface ReservationObserver {
  observe(target: Element): void
  disconnect(): void
}

interface ReservationMutationObserver {
  observe(target: Element, options: MutationObserverInit): void
  disconnect(): void
}

export type ComposerResizeObserverConstructor = new (callback: () => void) => ReservationObserver

export type ComposerMutationObserverConstructor = new (
  callback: () => void
) => ReservationMutationObserver

export interface ComposerReservationWindowTarget {
  addEventListener(type: 'resize', listener: () => void): void
  removeEventListener(type: 'resize', listener: () => void): void
}

export interface BindComposerReservationOptions {
  transcript: HTMLElement
  composerArea: HTMLElement
  resizeObserverCtor?: ComposerResizeObserverConstructor | null
  mutationObserverCtor?: ComposerMutationObserverConstructor | null
  windowTarget?: ComposerReservationWindowTarget | null
}

/**
 * Keep a transcript's scroll reserve aligned to its own Composer. The binding
 * owns no React state, so each Multiview pane can measure independently without
 * weakening its memo boundary or feeding transcript layout back into renders.
 */
export function bindComposerReservation({
  transcript,
  composerArea,
  resizeObserverCtor,
  mutationObserverCtor,
  windowTarget
}: BindComposerReservationOptions): () => void {
  const ResizeObserverCtor =
    resizeObserverCtor === undefined
      ? typeof ResizeObserver === 'undefined'
        ? null
        : (ResizeObserver as unknown as ComposerResizeObserverConstructor)
      : resizeObserverCtor
  const MutationObserverCtor =
    mutationObserverCtor === undefined
      ? typeof MutationObserver === 'undefined'
        ? null
        : (MutationObserver as unknown as ComposerMutationObserverConstructor)
      : mutationObserverCtor
  const resizeTarget =
    windowTarget === undefined
      ? typeof window === 'undefined'
        ? null
        : (window as unknown as ComposerReservationWindowTarget)
      : windowTarget

  let lastWrittenHeight = -1
  let lastAboveRowClearance = -1
  const updateReservation = (): void => {
    const measuredHeight = composerArea.getBoundingClientRect().height
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return
    const height = Math.ceil(measuredHeight)
    const aboveRowStack = composerArea.querySelector('.composer-above-bar-stack')
    const aboveRowsMinimized = composerArea.classList.contains(
      'composer-area--above-rows-minimized'
    )
    const aboveRowClearance = aboveRowsMinimized
      ? 0
      : composerAboveRowClearancePx(countComposerAboveRowStrips(aboveRowStack))
    if (height === lastWrittenHeight && aboveRowClearance === lastAboveRowClearance) return
    lastWrittenHeight = height
    lastAboveRowClearance = aboveRowClearance
    transcript.style.setProperty('--composer-reserved-height', `${height}px`)
    transcript.style.setProperty('--composer-above-row-clearance', `${aboveRowClearance}px`)
  }

  // The first value lands immediately; observers cover every subsequent grow,
  // shrink, wrap, and above-row mount without React state churn.
  updateReservation()

  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(updateReservation) : null
  resizeObserver?.observe(composerArea)
  const initialAboveRowStack = composerArea.querySelector('.composer-above-bar-stack')
  if (initialAboveRowStack) resizeObserver?.observe(initialAboveRowStack)

  // Row strips can appear/disappear without changing the outer height in the
  // same frame. Observe structure as well as geometry so clearance stays exact.
  const mutationObserver = MutationObserverCtor ? new MutationObserverCtor(updateReservation) : null
  mutationObserver?.observe(composerArea, {
    attributes: true,
    attributeFilter: ['class', 'hidden', 'style'],
    childList: true,
    subtree: true
  })
  resizeTarget?.addEventListener('resize', updateReservation)

  return () => {
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    resizeTarget?.removeEventListener('resize', updateReservation)
  }
}
