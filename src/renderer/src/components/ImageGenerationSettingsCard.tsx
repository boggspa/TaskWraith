import { useEffect, useState } from 'react'

/*
 * ImageGenerationSettingsCard — the renderer key-entry UI for the image_generate
 * MCP tool. The main process owns the secrets: keys are encrypted with
 * safeStorage and never returned to the renderer (get-status only reports a
 * boolean `configured` per provider). This card just drives the four wired IPC
 * methods (get-status / set-enabled / set-key / clear-key). image_generate is
 * OFF by default and refuses to run until enabled AND a key is configured.
 */

type ImageGenProvider = 'openai' | 'xai'

interface ImageGenStatus {
  enabled: boolean
  defaultProvider: ImageGenProvider
  encryptionAvailable: boolean
  configured: { openai: boolean; xai: boolean }
}

const PROVIDER_LABELS: Record<ImageGenProvider, string> = {
  openai: 'OpenAI (gpt-image-1)',
  xai: 'xAI Grok (grok-2-image)'
}

const NOTE_STYLE = { font: '11px/1.4 system-ui, sans-serif', opacity: 0.7 } as const
const ALERT_STYLE = {
  font: '11px/1.35 system-ui, sans-serif',
  color: 'var(--status-failed, #e5484d)'
} as const

export function ImageGenerationSettingsCard() {
  const [status, setStatus] = useState<ImageGenStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const api = typeof window !== 'undefined' ? window.api : undefined

  useEffect(() => {
    let cancelled = false
    void api
      ?.imageGenerationGetStatus?.()
      .then((s) => {
        if (!cancelled) setStatus(s as ImageGenStatus)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [api])

  // No bridge (tests/SSR) or status not loaded yet → render nothing.
  if (!api || !status) return null

  const provider = status.defaultProvider
  const configured = status.configured[provider]

  const run = async (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okNotice?: string
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await fn()
      if (result?.ok) {
        if (okNotice) setNotice(okNotice)
        const next = await api.imageGenerationGetStatus()
        setStatus(next as ImageGenStatus)
      } else {
        setError(result?.error || 'Could not update image generation.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-mcp-bridge-card">
      <label className="settings-effects-check-row">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy || !status.encryptionAvailable}
          onChange={(e) =>
            void run(() => api.imageGenerationSetEnabled({ enabled: e.target.checked, provider }))
          }
        />
        <span>
          Image generation (image_generate)
          <small>
            Lets agents create images from text via {PROVIDER_LABELS[provider]}. Off by default; the
            API key is stored encrypted on this Mac and is only sent to the provider you choose.
          </small>
        </span>
      </label>

      <div className="settings-mcp-bridge-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={NOTE_STYLE}>Provider</span>
          <select
            value={provider}
            disabled={busy}
            onChange={(e) =>
              void run(() =>
                api.imageGenerationSetEnabled({
                  enabled: status.enabled,
                  provider: e.target.value as ImageGenProvider
                })
              )
            }
          >
            <option value="openai">OpenAI</option>
            <option value="xai">xAI Grok</option>
          </select>
        </label>
        <span style={NOTE_STYLE}>
          {configured ? `${PROVIDER_LABELS[provider]} key saved` : 'No key saved'}
        </span>
      </div>

      <div className="settings-mcp-bridge-actions" style={{ gap: 8 }}>
        <input
          type="password"
          autoComplete="off"
          placeholder={`${PROVIDER_LABELS[provider]} API key`}
          value={keyDraft}
          disabled={busy || !status.encryptionAvailable}
          onChange={(e) => setKeyDraft(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !keyDraft.trim() || !status.encryptionAvailable}
          onClick={() =>
            void run(async () => {
              const result = await api.imageGenerationSetKey({ provider, key: keyDraft.trim() })
              if (result?.ok) setKeyDraft('')
              return result
            }, 'Key saved.')
          }
        >
          Save key
        </button>
        {configured && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => void run(() => api.imageGenerationClearKey({ provider }), 'Key cleared.')}
          >
            Clear
          </button>
        )}
      </div>

      {!status.encryptionAvailable ? (
        <div role="alert" style={ALERT_STYLE}>
          Secure storage is unavailable on this system, so an API key can&apos;t be saved safely —
          image generation stays disabled.
        </div>
      ) : error ? (
        <div role="alert" style={ALERT_STYLE}>
          {error}
        </div>
      ) : notice ? (
        <div style={NOTE_STYLE}>{notice}</div>
      ) : null}
    </div>
  )
}
