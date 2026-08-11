/**
 * Node-builtin-free provider setup catalog shared by desktop onboarding,
 * Settings, and remote first-launch projections.
 */

import { isLiveSelectableProvider } from './retiredProviders'

export interface ProviderInstallEntry {
  id: string
  label: string
  command: string
  source: string
  /** Display qualifier shown beside the label (for example "macOS / Linux"). */
  platform?: string
  /** NodeJS.Platform values this command applies to; undefined = any platform. */
  platforms?: readonly string[]
}

export interface OllamaModelEntry {
  id: string
  label: string
  command: string
}

export const PROVIDER_INSTALL_COMMANDS: readonly ProviderInstallEntry[] = [
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
    id: 'mistral',
    label: 'Mistral Vibe',
    command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
    source: 'Mistral',
    platform: 'macOS / Linux',
    platforms: ['darwin', 'linux']
  },
  {
    id: 'muse',
    label: 'Muse',
    command: 'curl -fsSL https://api.meta.ai/muse-launcher.sh | bash',
    source: 'Meta',
    platform: 'macOS / Linux',
    platforms: ['darwin', 'linux']
  },
  {
    id: 'pi',
    label: 'Pi',
    command: 'npm i -g @earendil-works/pi-coding-agent',
    source: 'Earendil'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    command: 'curl -fsSL https://ollama.com/install.sh | sh',
    source: 'Ollama',
    platform: 'macOS / Linux',
    platforms: ['darwin', 'linux']
  },
  {
    id: 'ollama-windows',
    label: 'Ollama',
    command: 'irm https://ollama.com/install.ps1 | iex',
    source: 'Ollama',
    platform: 'Windows',
    platforms: ['win32']
  }
]

export const OLLAMA_MODEL_COMMANDS: readonly OllamaModelEntry[] = [
  { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)', command: 'ollama run qwen3:4b-instruct' },
  { id: 'qwen3.5:2b', label: 'Qwen 3.5 (2B Param)', command: 'ollama run qwen3.5:2b' },
  { id: 'qwen3.5:4b', label: 'Qwen 3.5 (4B Param)', command: 'ollama run qwen3.5:4b' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)', command: 'ollama run qwen3.5:9b' },
  { id: 'qwen3.6:35b', label: 'Qwen 3.6 (35B-A3B)', command: 'ollama run qwen3.6:35b' },
  { id: 'gemma3:4b', label: 'Gemma 3 (4B Param)', command: 'ollama run gemma3:4b' },
  { id: 'gemma4:12b', label: 'Gemma 4 (12B Param)', command: 'ollama run gemma4:12b' },
  { id: 'ornith:9b', label: 'Ornith 1.0 (9B Param)', command: 'ollama run ornith:9b' },
  { id: 'ornith:35b', label: 'Ornith 1.0 (35B Param)', command: 'ollama run ornith:35b' },
  {
    id: 'laguna-xs-2.1:q8_0',
    label: 'Laguna XS 2.1 (33B-A3B Q8)',
    command: 'ollama run laguna-xs-2.1:q8_0'
  },
  { id: 'gpt-oss:20b', label: 'GPT OSS (20B Param)', command: 'ollama run gpt-oss:20b' },
  {
    id: 'lfm2.5-thinking:1.2b',
    label: 'LFM 2.5 Thinking (1.2B Param)',
    command: 'ollama run lfm2.5-thinking:1.2b'
  },
  { id: 'lfm2.5:8b', label: 'LFM 2.5 (8B-A1B)', command: 'ollama run lfm2.5:8b' },
  { id: 'minicpm-v4.5:8b', label: 'MiniCPM-V 4.5 (8B Param)', command: 'ollama run minicpm-v4.5:8b' },
  { id: 'granite4:3b', label: 'Granite 4.0 (3B Param)', command: 'ollama run granite4:3b' },
  { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)', command: 'ollama run granite4.1:3b' },
  { id: 'granite4.1:30b', label: 'Granite 4.1 (30B Param)', command: 'ollama run granite4.1:30b' },
  {
    id: 'nemotron-3-nano:4b',
    label: 'Nemotron 3 Nano (4B Param)',
    command: 'ollama run nemotron-3-nano:4b'
  },
  { id: 'nemotron3:33b', label: 'Nemotron 3 Nano Omni (33B Param)', command: 'ollama run nemotron3:33b' },
  {
    id: 'nemotron-3.5-lightning:30b-mlx',
    label: 'Nemotron 3.5 Lightning (30B-MLX)',
    command: 'ollama run nemotron-3.5-lightning:30b-mlx'
  },
  {
    id: 'devstral-small-2:24b',
    label: 'Devstral Small 2 (24B Param)',
    command: 'ollama run devstral-small-2:24b'
  },
  { id: 'ministral-3:3b', label: 'Ministral 3 (3B Param)', command: 'ollama run ministral-3:3b' },
  { id: 'ministral-3:14b', label: 'Ministral 3 (14B Param)', command: 'ollama run ministral-3:14b' },
  {
    id: 'muse-glimmer:30b-mlx',
    label: 'Muse Glimmer (30B-MLX)',
    command: 'ollama run muse-glimmer:30b-mlx'
  },
  { id: 'llama3.1:8b', label: 'Llama 3.1 (8B Param)', command: 'ollama run llama3.1:8b' },
  {
    id: 'deepseek-r1:1.5b',
    label: 'DeepSeek R1 (1.5B Param)',
    command: 'ollama run deepseek-r1:1.5b'
  },
  { id: 'deepseek-r1:8b', label: 'DeepSeek R1 (8B Param)', command: 'ollama run deepseek-r1:8b' },
  {
    id: 'rnj-1',
    label: 'Rnj-1 (8B Param; Ollama 0.13.3+)',
    command: 'ollama run rnj-1'
  },
  {
    id: 'glm-4.7-flash:q4_K_M',
    label: 'GLM-4.7-Flash (30B-A3B Q4; Ollama 0.15.0+)',
    command: 'ollama run glm-4.7-flash:q4_K_M'
  },
  {
    id: 'north-mini-code-1.0:q4_K_M',
    label: 'North Mini Code 1.0 (30B-A3B Q4; Ollama 0.30.10+)',
    command: 'ollama run north-mini-code-1.0:q4_K_M'
  },
  { id: 'llama3.2:3b', label: 'Llama 3.2 (3B Param)', command: 'ollama run llama3.2:3b' }
]

export interface CatalogInstallCommand {
  id: string
  label: string
  command: string
  kind: 'provider' | 'ollama-model'
  /** NodeJS.Platform values this command applies to; undefined = any platform. */
  platforms?: readonly string[]
}

/**
 * Resolve a catalog row id to its executable install command. This is the ONLY
 * lookup the auto-install IPC lane consults, so it applies the same
 * live-selectable filter the render sites do: a retired or security-disabled
 * provider's command is not executable even by id. Host CLIs (gh) are NOT here —
 * they run through the richer `host-tool:open-install-terminal` lane, which
 * also knows how to upgrade an existing install.
 */
export function findCatalogInstallCommand(id: unknown): CatalogInstallCommand | null {
  if (typeof id !== 'string' || id.length === 0) return null
  const provider = PROVIDER_INSTALL_COMMANDS.find(
    (entry) => entry.id === id && isLiveSelectableProvider(entry.id)
  )
  if (provider) {
    return {
      id: provider.id,
      label: provider.label,
      command: provider.command,
      kind: 'provider',
      platforms: provider.platforms
    }
  }
  const model = OLLAMA_MODEL_COMMANDS.find((entry) => entry.id === id)
  if (model) {
    return { id: model.id, label: model.label, command: model.command, kind: 'ollama-model' }
  }
  return null
}
