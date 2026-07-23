import type { ComposerStyle } from '../../../main/store/types'

export type ComposerVoicePlacement = 'permissions' | 'action-row' | 'send-cluster'

export function composerVoicePlacementForStyle(style: ComposerStyle): ComposerVoicePlacement {
  switch (style) {
    case 'claude':
    case 'gemini':
    case 'cursor':
    // ChatGPT shell borrows Cursor's capsule body + satellite controls, so the
    // voice control lives in the permissions row exactly as Cursor's does.
    case 'chatgpt':
    case 'modular':
    case 'obsidian':
    case 'alabaster':
      return 'permissions'
    case 'codex':
      return 'send-cluster'
    case 'default':
    case 'grok':
    case 'kimi':
    case 'terminal':
    case 'stub':
    case 'satellite':
      return 'action-row'
  }
}
