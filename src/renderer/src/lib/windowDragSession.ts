/**
 * Window-level mouse drag with a teardown the caller can force.
 *
 * A drag that only detaches on `mouseup` leaks whenever the component holding
 * it unmounts first — for the composer's terminal-resize divider that happens
 * in normal Multiview use (closing a pane, or the focus-steal swapping the
 * focused cell mid-drag). The listeners then outlive the component and retain
 * its whole closure, and a late `mouseup` would commit drag state to a dead
 * instance.
 *
 * `dispose()` detaches WITHOUT running `onEnd`, which is what unmount wants:
 * the drag is abandoned, not completed. Both paths are idempotent, so
 * end-then-unmount is safe, and `begin()` replaces any drag still running
 * rather than stacking a second pair of listeners.
 */
export interface WindowDragSessionHandlers {
  onMove: (event: MouseEvent) => void
  /** Runs only on a real drag end (mouseup), never on dispose. */
  onEnd: () => void
}

export interface WindowDragSession {
  begin: (handlers: WindowDragSessionHandlers) => void
  /** Abandon any running drag. Safe to call when nothing is running. */
  dispose: () => void
}

type DragEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

export function createWindowDragSession(target: DragEventTarget): WindowDragSession {
  let detach: (() => void) | null = null

  const dispose = (): void => {
    const current = detach
    detach = null
    current?.()
  }

  return {
    begin: (handlers) => {
      dispose()
      const handleMove = (event: Event): void => handlers.onMove(event as MouseEvent)
      const handleUp = (): void => {
        dispose()
        handlers.onEnd()
      }
      target.addEventListener('mousemove', handleMove)
      target.addEventListener('mouseup', handleUp)
      detach = () => {
        target.removeEventListener('mousemove', handleMove)
        target.removeEventListener('mouseup', handleUp)
      }
    },
    dispose
  }
}
