import { useState, type ReactElement } from 'react'
import { isRetiredProvider } from '../../../shared/retiredProviders'

interface ProviderInstallEntry {
  id: string
  label: string
  command: string
  /** The vendor the command comes from — shown on hover so a newcomer
   * can confirm it's the official source, not a third-party script. */
  source: string
  /** Optional per-OS variant of the install command (e.g. Ollama ships a
   * curl installer for macOS/Linux and a PowerShell one for Windows).
   * When present, the label gets the OS suffix so both copy-rows are
   * unambiguous. */
  platform?: string
}

interface OllamaModelEntry {
  id: string
  label: string
  /** `ollama run <id>` — the id MUST match the model id TaskWraith sends
   * to the Ollama runtime (see OLLAMA_DEFAULT_MODELS in
   * lib/providerModelDefaults.ts) so the pulled local model is the exact
   * tag the app invokes. */
  command: string
}

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
const PROVIDER_INSTALL_COMMANDS: ProviderInstallEntry[] = [
  { id: 'codex', label: 'Codex', command: 'npm i -g @openai/codex', source: 'OpenAI' },
  {
    id: 'claude',
    label: 'Claude',
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    source: 'Anthropic'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    command: 'curl -LsSf https://code.kimi.com/install.sh | bash',
    source: 'Moonshot'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    command: 'curl https://cursor.com/install -fsS | bash',
    source: 'Cursor'
  },
  {
    id: 'grok',
    label: 'Grok',
    command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    source: 'xAI'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    command: 'curl -fsSL https://ollama.com/install.sh | sh',
    source: 'Ollama',
    platform: 'macOS / Linux'
  },
  {
    id: 'ollama-windows',
    label: 'Ollama',
    command: 'irm https://ollama.com/install.ps1 | iex',
    source: 'Ollama',
    platform: 'Windows'
  }
]

/**
 * Once Ollama itself is installed, these pull + run each local model
 * TaskWraith currently allows. Labels mirror OLLAMA_DEFAULT_MODELS so the
 * names match the model picker; the `ollama run <id>` tag is the exact id
 * the app sends to the runtime, so the model the user pulls is the one the
 * app will actually invoke. Keep in sync with
 * lib/providerModelDefaults.ts (OLLAMA_DEFAULT_MODELS).
 */
const OLLAMA_MODEL_COMMANDS: OllamaModelEntry[] = [
  { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)', command: 'ollama run qwen3:4b-instruct' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)', command: 'ollama run qwen3.5:9b' },
  { id: 'qwen3.6:35b', label: 'Qwen 3.6 (35B-A3B)', command: 'ollama run qwen3.6:35b' },
  { id: 'gemma4:12b', label: 'Gemma 4 (12B Param)', command: 'ollama run gemma4:12b' },
  { id: 'gpt-oss:20b', label: 'GPT OSS (20B Param)', command: 'ollama run gpt-oss:20b' },
  { id: 'minicpm-v4.5:8b', label: 'MiniCPM-V 4.5 (8B Param)', command: 'ollama run minicpm-v4.5:8b' },
  { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)', command: 'ollama run granite4.1:3b' },
  { id: 'granite4.1:30b', label: 'Granite 4.1 (30B Param)', command: 'ollama run granite4.1:30b' },
  { id: 'nemotron3:33b', label: 'Nemotron 3 Nano Omni (33B Param)', command: 'ollama run nemotron3:33b' }
]

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
