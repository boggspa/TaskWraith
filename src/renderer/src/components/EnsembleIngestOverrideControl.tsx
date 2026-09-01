/*
 * EnsembleIngestOverrideControl — the per-model shared-history ingest slider
 * shown on eligible rows of the Context · per participant panel.
 *
 * Only two model classes are eligible (see shared/ensembleSeatIngest.ts):
 * Codex GPT-5.3 Spark and 4B–12B-parameter local Ollama models. Everyone else
 * sizes ingest automatically from the model's context window, so no control
 * renders for them.
 *
 * Deliberately self-contained: reads and writes
 * `AppSettings.ensembleModelIngestChars` through window.api directly (the
 * SettingsPanel precedent) instead of threading props through App.tsx — the
 * popover mounts in the composer, and the setting is app-wide per-model, not
 * per-chat.
 */

import { useEffect, useRef, useState } from 'react'
import {
  ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS,
  ENSEMBLE_INGEST_OVERRIDE_MAX_CHARS,
  ENSEMBLE_INGEST_OVERRIDE_MIN_CHARS,
  clampEnsembleIngestOverrideChars,
  ensembleIngestOverrideKey
} from '../../../shared/ensembleSeatIngest'

function formatIngestChars(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}K` : `${chars}`
}

export function EnsembleIngestOverrideControl({
  provider,
  modelId
}: {
  provider: string
  modelId: string
}): React.JSX.Element {
  const overrideKey = ensembleIngestOverrideKey(provider, modelId)
  const [chars, setChars] = useState<number>(ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS)
  const [loaded, setLoaded] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    void window.api
      .getSettings()
      .then((settings) => {
        if (!mountedRef.current) return
        const stored = settings?.ensembleModelIngestChars?.[overrideKey]
        if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) {
          setChars(clampEnsembleIngestOverrideChars(stored))
        }
        setLoaded(true)
      })
      .catch(() => {
        if (mountedRef.current) setLoaded(true)
      })
    return () => {
      mountedRef.current = false
    }
  }, [overrideKey])

  const commit = (value: number): void => {
    const next = clampEnsembleIngestOverrideChars(value)
    setChars(next)
    // Read-modify-write against the LIVE settings record so a commit never
    // stomps overrides saved for other models since this popover mounted.
    void window.api
      .getSettings()
      .then((settings) =>
        window.api.updateSettings({
          ensembleModelIngestChars: {
            ...(settings?.ensembleModelIngestChars || {}),
            [overrideKey]: next
          }
        })
      )
      .catch(() => {})
  }

  return (
    <div
      className="context-meter-ingest-override"
      data-testid="ensemble-ingest-override"
      title="Shared-history ingest for this model. This model class defaults to 50K; other models size their ingest automatically from their context window."
    >
      <span className="context-meter-ingest-override-label">History ingest</span>
      <input
        type="range"
        className="context-meter-ingest-override-slider"
        min={ENSEMBLE_INGEST_OVERRIDE_MIN_CHARS}
        max={ENSEMBLE_INGEST_OVERRIDE_MAX_CHARS}
        step={5_000}
        value={chars}
        disabled={!loaded}
        aria-label={`Shared-history ingest for ${modelId}`}
        onChange={(event) => setChars(Number(event.target.value))}
        onPointerUp={() => commit(chars)}
        onKeyUp={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') commit(chars)
        }}
      />
      <span className="context-meter-ingest-override-value">{formatIngestChars(chars)}</span>
    </div>
  )
}
