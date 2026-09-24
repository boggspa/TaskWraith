import { useState, useSyncExternalStore } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import type { RendererChatPendingDrafts } from '../lib/RendererChatPendingDrafts'

export function RendererChatConflictNotice({
  chatId,
  drafts,
  onResolved,
  beforeResolve,
  getCurrent
}: {
  chatId?: string
  drafts: RendererChatPendingDrafts
  beforeResolve(chatId: string): Promise<void>
  getCurrent(chatId: string): ChatRecord | undefined
  onResolved(chat: ChatRecord, advanced?: ChatRecord): unknown
}): React.JSX.Element | null {
  useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!chatId || !drafts.conflicts(chatId).length) return null
  const resolve = async (keepLocal: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const before = getCurrent(chatId)
      if (!before) throw new Error('The local draft is unavailable')
      drafts.trackTarget(before)
      await beforeResolve(chatId)
      if (!drafts.isCurrentTarget(before)) return
      const canonical = await window.api.getChat(chatId)
      if (!drafts.isCurrentTarget(before)) return
      if (!canonical) throw new Error('This task is no longer available.')
      if (keepLocal) {
        const local = drafts.resolveLocal(canonical, getCurrent(chatId))
        drafts.trackTarget(local)
        const saved = await window.api.saveChat(local)
        const advanced = drafts.advance(local, saved, getCurrent(chatId), saved)
        if (advanced) onResolved(saved, advanced.record)
      } else {
        const current = getCurrent(chatId)
        drafts.discard(chatId)
        drafts.trackTarget(before)
        const advanced = drafts.advance(before, canonical, current, canonical)
        if (advanced) onResolved(canonical, advanced.record)
      }
    } catch {
      setError('Could not save this choice. Your local draft is retained.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 1000,
        padding: 12,
        borderRadius: 8,
        maxWidth: 420,
        background: 'var(--bg-secondary, #252525)',
        color: 'var(--text-primary, #eee)',
        fontSize: 13
      }}
    >
      <p style={{ margin: '0 0 8px' }}>
        Some local changes overlap a saved update. Your local draft is still shown.
      </p>
      {error && <p>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          disabled={busy}
          onClick={() => {
            void resolve(true)
          }}
        >
          Save local changes
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void resolve(false)
          }}
        >
          Use saved version
        </button>
      </div>
    </div>
  )
}
