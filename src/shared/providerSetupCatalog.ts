/**
 * Node-builtin-free provider setup catalog shared by desktop onboarding,
 * Settings, and remote first-launch projections.
 */

export interface ProviderInstallEntry {
  id: string
  label: string
  command: string
  source: string
  platform?: string
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

export const OLLAMA_MODEL_COMMANDS: readonly OllamaModelEntry[] = [
  { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)', command: 'ollama run qwen3:4b-instruct' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)', command: 'ollama run qwen3.5:9b' },
  { id: 'qwen3.6:35b', label: 'Qwen 3.6 (35B-A3B)', command: 'ollama run qwen3.6:35b' },
  { id: 'gemma4:12b', label: 'Gemma 4 (12B Param)', command: 'ollama run gemma4:12b' },
  { id: 'ornith:9b', label: 'Ornith 1.0 (9B Param)', command: 'ollama run ornith:9b' },
  { id: 'ornith:35b', label: 'Ornith 1.0 (35B Param)', command: 'ollama run ornith:35b' },
  { id: 'gpt-oss:20b', label: 'GPT OSS (20B Param)', command: 'ollama run gpt-oss:20b' },
  { id: 'minicpm-v4.5:8b', label: 'MiniCPM-V 4.5 (8B Param)', command: 'ollama run minicpm-v4.5:8b' },
  { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)', command: 'ollama run granite4.1:3b' },
  { id: 'granite4.1:30b', label: 'Granite 4.1 (30B Param)', command: 'ollama run granite4.1:30b' },
  { id: 'nemotron3:33b', label: 'Nemotron 3 Nano Omni (33B Param)', command: 'ollama run nemotron3:33b' }
]
