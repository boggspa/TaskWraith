import { useEffect, useState, type ReactElement } from 'react'
import { isLiveSelectableProvider } from '../../../shared/retiredProviders'
import {
  OLLAMA_MODEL_COMMANDS,
  PROVIDER_INSTALL_COMMANDS
} from '../../../shared/providerSetupCatalog'
import type {
  TaskWraithPluginActivatedProviderSetup,
  TaskWraithPluginActivationSnapshot
} from '../../../shared/plugins/PluginTypes'
import { PillButton } from './PillButton'

/**
 * Official, copy-pasteable CLI install commands — one per provider, each
 * taken from that vendor's own published install docs. Surfaced in BOTH
 * the first-launch onboarding sheet and Settings → Providers so people
 * who live in ChatGPT/Claude.ai and have never touched a terminal can
 * get a CLI installed without hunting through six different doc sites.
 *
 * Keep these in sync with the vendors' official install pages:
 *   Codex  — OpenAI:    npm i -g @openai/codex                         (developers.openai.com/codex/cli)
 *   Claude — Anthropic: curl -fsSL https://claude.ai/install.sh | bash (code.claude.com/docs/en/setup)
 *   Kimi   — Moonshot:  curl -LsSf https://code.kimi.com/install.sh    (code.kimi.com)
 *   Grok   — xAI:       curl -fsSL https://x.ai/cli/install.sh | bash  (x.ai/cli)
 *   Ollama — Ollama:    curl -fsSL https://ollama.com/install.sh | sh  (ollama.com)
 * (npm commands need Node 20+; the curl installers are self-contained.)
 */
/**
 * Rows of copyable official install commands. Pure presentation +
 * clipboard; the host decides whether to wrap it in a <details> (we do
 * in both call sites to keep the surfaces tidy by default).
 */
interface ProviderInstallCommandsProps {
  providerSetup?: TaskWraithPluginActivatedProviderSetup[]
}

export function ProviderInstallCommands({
  providerSetup
}: ProviderInstallCommandsProps = {}): ReactElement {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [loadedActivation, setLoadedActivation] =
    useState<TaskWraithPluginActivationSnapshot | null>(null)

  useEffect(() => {
    if (providerSetup !== undefined) return
    if (typeof window === 'undefined' || typeof window.api?.getPluginActivation !== 'function') {
      return
    }
    let cancelled = false
    void window.api
      .getPluginActivation()
      .then((snapshot) => {
        if (!cancelled) setLoadedActivation(snapshot)
      })
      .catch(() => {
        if (!cancelled) setLoadedActivation(null)
      })
    return () => {
      cancelled = true
    }
  }, [providerSetup])

  const activeProviderSetup = (providerSetup ?? loadedActivation?.providerSetup ?? []).filter(
    (entry) => isLiveSelectableProvider(entry.setup.provider)
  )

  const copy = (rowId: string, command: string): void => {
    void navigator.clipboard?.writeText(command)
    setCopiedId(rowId)
    // Transient "Copied" confirmation; clears only if this row is still
    // the one showing it (so a quick second copy doesn't flash-clear).
    window.setTimeout(() => setCopiedId((cur) => (cur === rowId ? null : cur)), 1500)
  }

  return (
    <div className="provider-install-commands">
      {/* Historical or security-disabled providers are never offered an install
          command; only the canonical live-selectable set reaches this list. */}
      {PROVIDER_INSTALL_COMMANDS.filter((entry) =>
        isLiveSelectableProvider(entry.id)
      ).map((entry) => {
        const rowLabel = entry.platform ? `${entry.label} (${entry.platform})` : entry.label
        return (
          <div
            key={entry.id}
            className={`provider-install-row${entry.platform ? ' is-model' : ''}`}
            data-provider={entry.id}
          >
            <span className="provider-install-label">{rowLabel}</span>
            <code
              className="provider-install-cmd"
              title={`Official ${entry.source} install command`}
            >
              {entry.command}
            </code>
            <PillButton
              size="compact"
              className="provider-install-copy"
              onClick={() => copy(entry.id, entry.command)}
              aria-label={`Copy ${rowLabel} install command`}
            >
              {copiedId === entry.id ? 'Copied' : 'Copy'}
            </PillButton>
          </div>
        )
      })}
      {activeProviderSetup.length > 0 && (
        <>
          <div className="provider-install-subhead">
            Plugin setup recipes — activated capability packages
          </div>
          {activeProviderSetup.map((entry) => {
            const label = entry.setup.label || entry.setup.provider
            const detail = [entry.setup.installHint, entry.setup.authHint]
              .filter((hint): hint is string => Boolean(hint?.trim()))
              .join(' ')
            const checks = entry.setup.preflightChecks?.length
              ? `checks: ${entry.setup.preflightChecks.join(', ')}`
              : 'setup metadata'
            return (
              <div
                key={entry.id}
                className="provider-install-row is-model"
                data-provider={entry.setup.provider}
              >
                <span className="provider-install-label">{label}</span>
                <span
                  className="provider-install-cmd"
                  title={`${entry.plugin.pluginId} · ${checks}`}
                >
                  {detail || `${entry.plugin.pluginId} · ${checks}`}
                </span>
                <span className="provider-install-copy" title={entry.plugin.publisher}>
                  {entry.plugin.pluginId}
                </span>
              </div>
            )
          })}
        </>
      )}
      {/* Ollama is local: after the runtime is installed, each model has to
          be pulled separately. These rows pull + run the exact tags
          TaskWraith allows so the model picker lights up with a working
          local model. */}
      <div className="provider-install-subhead">Ollama models — pull after installing Ollama</div>
      {OLLAMA_MODEL_COMMANDS.map((model) => (
        <div
          key={model.id}
          className="provider-install-row is-model"
          data-provider="ollama"
        >
          <span className="provider-install-label">{model.label}</span>
          <code
            className="provider-install-cmd"
            title={`Pull and run ${model.label} with Ollama`}
          >
            {model.command}
          </code>
          <PillButton
            size="compact"
            className="provider-install-copy"
            onClick={() => copy(model.id, model.command)}
            aria-label={`Copy ${model.label} install command`}
          >
            {copiedId === model.id ? 'Copied' : 'Copy'}
          </PillButton>
        </div>
      ))}
    </div>
  )
}
