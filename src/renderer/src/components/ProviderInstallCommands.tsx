import { useState, type ReactElement } from 'react'
import { isRetiredProvider } from '../../../shared/retiredProviders'
import {
  OLLAMA_MODEL_COMMANDS,
  PROVIDER_INSTALL_COMMANDS
} from '../../../shared/providerSetupCatalog'

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
 *   Kimi   — Moonshot:  curl -LsSf https://code.kimi.com/install.sh    (moonshotai.github.io/kimi-cli)
 *   Cursor — Cursor:    curl https://cursor.com/install -fsS | bash    (cursor.com/docs/cli/installation)
 *   Grok   — xAI:       curl -fsSL https://x.ai/cli/install.sh | bash  (x.ai/cli)
 *   Ollama — Ollama:    curl -fsSL https://ollama.com/install.sh | sh  (ollama.com)
 * (npm commands need Node 20+; the curl installers are self-contained.)
 */
/**
 * Rows of copyable official install commands. Pure presentation +
 * clipboard; the host decides whether to wrap it in a <details> (we do
 * in both call sites to keep the surfaces tidy by default).
 */
export function ProviderInstallCommands(): ReactElement {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copy = (rowId: string, command: string): void => {
    void navigator.clipboard?.writeText(command)
    setCopiedId(rowId)
    // Transient "Copied" confirmation; clears only if this row is still
    // the one showing it (so a quick second copy doesn't flash-clear).
    window.setTimeout(() => setCopiedId((cur) => (cur === rowId ? null : cur)), 1500)
  }

  return (
    <div className="provider-install-commands">
      {/* Retired providers (retiredProviders.ts) are never offered an install
          command — defensive backstop; the list above already omits them. */}
      {PROVIDER_INSTALL_COMMANDS.filter((entry) => !isRetiredProvider(entry.id)).map((entry) => {
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
            <button
              type="button"
              className="btn btn-sm provider-install-copy"
              onClick={() => copy(entry.id, entry.command)}
              aria-label={`Copy ${rowLabel} install command`}
            >
              {copiedId === entry.id ? 'Copied' : 'Copy'}
            </button>
          </div>
        )
      })}
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
          <button
            type="button"
            className="btn btn-sm provider-install-copy"
            onClick={() => copy(model.id, model.command)}
            aria-label={`Copy ${model.label} install command`}
          >
            {copiedId === model.id ? 'Copied' : 'Copy'}
          </button>
        </div>
      ))}
    </div>
  )
}
