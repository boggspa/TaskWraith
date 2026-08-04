import { useEffect, useState, type ReactElement } from 'react'
import { isLiveSelectableProvider } from '../../../shared/retiredProviders'
import {
  OLLAMA_MODEL_COMMANDS,
  PROVIDER_INSTALL_COMMANDS
} from '../../../shared/providerSetupCatalog'
import { HOST_CLI_TOOLS } from '../../../shared/hostCliToolCatalog'
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
 *   Mistral — Mistral:  curl -LsSf https://mistral.ai/vibe/install.sh | bash (docs.mistral.ai)
 *   Ollama — Ollama:    curl -fsSL https://ollama.com/install.sh | sh  (ollama.com)
 * (npm commands need Node 20+; the curl installers are self-contained.)
 */
/**
 * Rows of official install commands: Copy puts the command on the clipboard,
 * Install opens a Terminal window running it (ids only cross IPC — main
 * re-resolves each command from the shared catalog). The host decides whether
 * to wrap it in a <details> (we do in both call sites to keep the surfaces
 * tidy by default).
 */
interface ProviderInstallCommandsProps {
  providerSetup?: TaskWraithPluginActivatedProviderSetup[]
}

type InstallPhase = 'opening' | 'opened' | 'failed'

export function ProviderInstallCommands({
  providerSetup
}: ProviderInstallCommandsProps = {}): ReactElement {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [installState, setInstallState] = useState<{ id: string; phase: InstallPhase } | null>(null)
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

  // Same coarse heuristic as HostCliToolInstall: good enough to pick between
  // the win32 and darwin/linux command families for row visibility.
  const effectivePlatform =
    typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '') ? 'win32' : 'darwin'

  const copy = (rowId: string, command: string): void => {
    void navigator.clipboard?.writeText(command)
    setCopiedId(rowId)
    // Transient "Copied" confirmation; clears only if this row is still
    // the one showing it (so a quick second copy doesn't flash-clear).
    window.setTimeout(() => setCopiedId((cur) => (cur === rowId ? null : cur)), 1500)
  }

  const settleInstall = (rowId: string, phase: InstallPhase): void => {
    setInstallState({ id: rowId, phase })
    window.setTimeout(
      () => setInstallState((cur) => (cur?.id === rowId ? null : cur)),
      phase === 'failed' ? 4000 : 2000
    )
  }

  const runInstall = (rowId: string, invoke: () => Promise<{ ok: boolean; error?: string }>) => {
    if (installState?.phase === 'opening') return
    setInstallState({ id: rowId, phase: 'opening' })
    void invoke()
      .then((result) => {
        if (!result?.ok) {
          console.warn('[install-command] could not open Terminal:', result?.error)
          settleInstall(rowId, 'failed')
          return
        }
        settleInstall(rowId, 'opened')
      })
      .catch((error) => {
        console.warn('[install-command] could not open Terminal:', error)
        settleInstall(rowId, 'failed')
      })
  }

  const installLabel = (rowId: string): string => {
    if (installState?.id !== rowId) return 'Install'
    if (installState.phase === 'opening') return 'Opening…'
    return installState.phase === 'opened' ? 'Opened' : 'Failed'
  }

  const installButton = (
    rowId: string,
    ariaLabel: string,
    invoke: () => Promise<{ ok: boolean; error?: string }>
  ): ReactElement => (
    <PillButton
      size="compact"
      variant="primary"
      className="provider-install-run"
      onClick={() => runInstall(rowId, invoke)}
      aria-label={ariaLabel}
      title="Opens a Terminal window running this command"
    >
      {installLabel(rowId)}
    </PillButton>
  )

  return (
    <div className="provider-install-commands">
      {/* Historical or security-disabled providers are never offered an install
          command; only the canonical live-selectable set reaches this list. */}
      {PROVIDER_INSTALL_COMMANDS.filter((entry) => isLiveSelectableProvider(entry.id)).map(
        (entry) => {
          const rowLabel = entry.platform ? `${entry.label} (${entry.platform})` : entry.label
          const installable = !entry.platforms || entry.platforms.includes(effectivePlatform)
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
              {installable &&
                installButton(entry.id, `Run the ${rowLabel} install command in Terminal`, () =>
                  window.api.openInstallCommandTerminal(entry.id)
                )}
            </div>
          )
        }
      )}
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
      {/* Optional host CLIs. These are NOT providers — `gh` has no seat, model,
          or run posture — but they were the one class of missing binary the
          install catalog never covered, so a user who hit "GitHub CLI isn't
          installed or isn't on PATH" in the PR popover had nowhere to go. */}
      <div className="provider-install-subhead">
        Optional tools — extra TaskWraith features, not providers
      </div>
      {HOST_CLI_TOOLS.flatMap((tool) =>
        tool.installCommands.map((entry) => (
          <div key={entry.id} className="provider-install-row is-model" data-host-tool={tool.id}>
            <span className="provider-install-label">
              {tool.label} ({entry.platform})
            </span>
            <code
              className="provider-install-cmd"
              title={`Official ${tool.source} install command — ${tool.purpose}`}
            >
              {entry.command}
            </code>
            <PillButton
              size="compact"
              className="provider-install-copy"
              onClick={() => copy(entry.id, entry.command)}
              aria-label={`Copy ${tool.label} (${entry.platform}) install command`}
            >
              {copiedId === entry.id ? 'Copied' : 'Copy'}
            </PillButton>
            {entry.platforms.includes(effectivePlatform) &&
              installButton(
                entry.id,
                `Run the ${tool.label} (${entry.platform}) install command in Terminal`,
                // The host-tool lane (not the catalog lane): it upgrades an
                // already-installed copy instead of blindly reinstalling.
                () => window.api.openHostToolInstallTerminal(tool.id)
              )}
          </div>
        ))
      )}
      {/* Ollama is local: after the runtime is installed, each model has to
          be pulled separately. These rows pull + run the exact tags
          TaskWraith allows so the model picker lights up with a working
          local model. */}
      <div className="provider-install-subhead">Ollama models — pull after installing Ollama</div>
      {OLLAMA_MODEL_COMMANDS.map((model) => (
        <div key={model.id} className="provider-install-row is-model" data-provider="ollama">
          <span className="provider-install-label">{model.label}</span>
          <code className="provider-install-cmd" title={`Pull and run ${model.label} with Ollama`}>
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
          {installButton(model.id, `Run the ${model.label} pull command in Terminal`, () =>
            window.api.openInstallCommandTerminal(model.id)
          )}
        </div>
      ))}
    </div>
  )
}
