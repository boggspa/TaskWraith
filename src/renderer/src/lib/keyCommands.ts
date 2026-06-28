import type { AppSettings, KeyCommandModifier } from '../../../main/store/types'

export type KeyCommandId =
  | 'command-palette'
  | 'settings'
  | 'close-overlays'
  | 'run-prompt'
  | 'search-workspaces'
  | 'new-chat'
  | 'stop-run'
  | 'copy-transcript'
  | 'review-current-diff'
  | 'attach-files'
  | 'attach-window'
  | 'toggle-sidebar'
  | 'toggle-inspector'
  | 'toggle-file-editor'
  | 'open-diff-studio-window'
  | 'open-file-editor-window'
  | 'popout-chat-window'

export type KeyCommandGroup = 'Global' | 'Chat' | 'Composer' | 'Actions' | 'Panels' | 'Windows'

export type KeyCommandBinding = Exclude<
  NonNullable<AppSettings['keyCommandBindings']>[string],
  null
>
export type KeyCommandBindings = Partial<Record<KeyCommandId, KeyCommandBinding | null>>

export type KeyCommandDefinition = {
  id: KeyCommandId
  group: KeyCommandGroup
  command: string
  description: string
  defaultBinding: KeyCommandBinding | null
  allowWhenEditable?: boolean
}

const PRIMARY_MODIFIER = 'primary'
const SHIFT_MODIFIER = 'shift'
const ALT_MODIFIER = 'alt'
const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'Hyper',
  'Meta',
  'NumLock',
  'OS',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock'
])

export const KEY_COMMAND_GROUPS: KeyCommandGroup[] = [
  'Global',
  'Chat',
  'Composer',
  'Actions',
  'Panels',
  'Windows'
]

export const KEY_COMMAND_DEFINITIONS: KeyCommandDefinition[] = [
  {
    id: 'command-palette',
    group: 'Global',
    command: 'Slash commands',
    description: 'Open slash commands in the composer.',
    defaultBinding: { key: 'K', modifiers: [PRIMARY_MODIFIER] },
    allowWhenEditable: true
  },
  {
    id: 'settings',
    group: 'Global',
    command: 'Open Settings',
    description: 'Open the Settings takeover from anywhere in the app.',
    defaultBinding: { key: ',', modifiers: [PRIMARY_MODIFIER] },
    allowWhenEditable: true
  },
  {
    id: 'close-overlays',
    group: 'Global',
    command: 'Close overlay',
    description: 'Close Settings, composer slash commands, active modal, or custom model edit.',
    defaultBinding: { key: 'Escape', modifiers: [] },
    allowWhenEditable: true
  },
  {
    id: 'run-prompt',
    group: 'Global',
    command: 'Run prompt',
    description: 'Submit the current composer prompt even when focus is inside the composer.',
    defaultBinding: { key: 'Enter', modifiers: [PRIMARY_MODIFIER] },
    allowWhenEditable: true
  },
  {
    id: 'search-workspaces',
    group: 'Global',
    command: 'Search workspaces and threads',
    description: 'Focus the workspace sidebar search field.',
    defaultBinding: { key: 'F', modifiers: [PRIMARY_MODIFIER, SHIFT_MODIFIER] },
    allowWhenEditable: true
  },
  {
    id: 'new-chat',
    group: 'Chat',
    command: 'New chat',
    description: 'Create a new chat in the current workspace, or a general chat when no workspace is active.',
    defaultBinding: { key: 'N', modifiers: [PRIMARY_MODIFIER] },
    allowWhenEditable: true
  },
  {
    id: 'stop-run',
    group: 'Chat',
    command: 'Stop current run',
    description: 'Cancel the current chat run when that chat has an active task.',
    defaultBinding: { key: '.', modifiers: [PRIMARY_MODIFIER] },
    allowWhenEditable: true
  },
  {
    id: 'copy-transcript',
    group: 'Chat',
    command: 'Copy transcript',
    description: 'Copy the current chat transcript as Markdown.',
    defaultBinding: null
  },
  {
    id: 'attach-files',
    group: 'Composer',
    command: 'Attach files',
    description: 'Open the file picker for composer attachments.',
    defaultBinding: null,
    allowWhenEditable: true
  },
  {
    id: 'attach-window',
    group: 'Composer',
    command: 'Attach window',
    description: 'Pick a window for Screen Watch / attached-window context.',
    defaultBinding: null,
    allowWhenEditable: true
  },
  {
    id: 'review-current-diff',
    group: 'Actions',
    command: 'Review current diff',
    description: 'Open Diff Studio and start a review of the current workspace diff.',
    defaultBinding: null
  },
  {
    id: 'toggle-sidebar',
    group: 'Panels',
    command: 'Toggle sidebar',
    description: 'Show or hide the workspace and thread sidebar.',
    defaultBinding: { key: 'B', modifiers: [PRIMARY_MODIFIER] }
  },
  {
    id: 'toggle-inspector',
    group: 'Panels',
    command: 'Toggle inspector',
    description: 'Show or hide the run inspector.',
    defaultBinding: { key: 'I', modifiers: [PRIMARY_MODIFIER] }
  },
  {
    id: 'toggle-file-editor',
    group: 'Panels',
    command: 'Toggle file editor',
    description: 'Show or hide the file editor panel.',
    defaultBinding: { key: 'E', modifiers: [PRIMARY_MODIFIER] }
  },
  {
    id: 'open-diff-studio-window',
    group: 'Windows',
    command: 'Open Diff Studio Window',
    description: 'Open Diff Studio for the current workspace in a floating window.',
    defaultBinding: { key: 'D', modifiers: [PRIMARY_MODIFIER, SHIFT_MODIFIER] }
  },
  {
    id: 'open-file-editor-window',
    group: 'Windows',
    command: 'Open File Editor Window',
    description: 'Open the file editor for the current workspace in a floating window.',
    defaultBinding: { key: 'E', modifiers: [PRIMARY_MODIFIER, SHIFT_MODIFIER] }
  },
  {
    id: 'popout-chat-window',
    group: 'Windows',
    command: 'Popout Chat Window',
    description: 'Open the current chat transcript in a dedicated floating window.',
    defaultBinding: { key: 'O', modifiers: [PRIMARY_MODIFIER, SHIFT_MODIFIER] }
  }
]

const KEY_COMMAND_IDS = new Set<KeyCommandId>(
  KEY_COMMAND_DEFINITIONS.map((definition) => definition.id)
)

const modifierOrder = (modifier: string): number => {
  if (modifier === PRIMARY_MODIFIER) return 0
  if (modifier === SHIFT_MODIFIER) return 1
  if (modifier === ALT_MODIFIER) return 2
  return 10
}

const normalizeKey = (key: string): string => {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

const normalizeModifiers = (
  modifiers: readonly string[] | undefined
): KeyCommandModifier[] => {
  const unique = new Set<KeyCommandModifier>()
  for (const modifier of modifiers || []) {
    if (modifier === PRIMARY_MODIFIER || modifier === SHIFT_MODIFIER || modifier === ALT_MODIFIER) {
      unique.add(modifier)
    }
  }
  return Array.from(unique).sort((a, b) => modifierOrder(a) - modifierOrder(b))
}

export const normalizeKeyCommandBinding = (
  binding: KeyCommandBinding | null | undefined
): KeyCommandBinding | null => {
  if (!binding || typeof binding.key !== 'string') return null
  const key = binding.key === ' ' ? binding.key : binding.key.trim()
  if (!key) return null
  return {
    key: normalizeKey(key),
    modifiers: normalizeModifiers(binding.modifiers)
  }
}

export const resolveKeyCommandBindings = (
  overrides: AppSettings['keyCommandBindings'] | null | undefined
): KeyCommandBindings => {
  const resolved: KeyCommandBindings = {}
  for (const definition of KEY_COMMAND_DEFINITIONS) {
    const override = overrides?.[definition.id]
    resolved[definition.id] =
      override === null
        ? null
        : normalizeKeyCommandBinding(override) || definition.defaultBinding
  }
  return resolved
}

export const sanitizeKeyCommandOverrides = (
  value: AppSettings['keyCommandBindings'] | null | undefined
): AppSettings['keyCommandBindings'] => {
  const sanitized: AppSettings['keyCommandBindings'] = {}
  if (!value || typeof value !== 'object') return sanitized
  for (const [id, binding] of Object.entries(value)) {
    if (!KEY_COMMAND_IDS.has(id as KeyCommandId)) continue
    sanitized[id] = binding === null ? null : normalizeKeyCommandBinding(binding)
  }
  return sanitized
}

export const bindingFromKeyboardEvent = (event: KeyboardEvent): KeyCommandBinding | null => {
  if (!event.key || MODIFIER_KEYS.has(event.key)) return null
  const modifiers: KeyCommandModifier[] = []
  if (event.metaKey || event.ctrlKey) modifiers.push(PRIMARY_MODIFIER)
  if (event.shiftKey) modifiers.push(SHIFT_MODIFIER)
  if (event.altKey) modifiers.push(ALT_MODIFIER)
  return normalizeKeyCommandBinding({ key: event.key, modifiers })
}

export const serializeKeyCommandBinding = (
  binding: KeyCommandBinding | null | undefined
): string => {
  const normalized = normalizeKeyCommandBinding(binding)
  if (!normalized) return ''
  return `${normalized.modifiers.join('+')}|${normalized.key.toLowerCase()}`
}

export const keyCommandMatchesEvent = (
  binding: KeyCommandBinding | null | undefined,
  event: KeyboardEvent
): boolean => {
  const normalized = normalizeKeyCommandBinding(binding)
  if (!normalized) return false
  const actual = bindingFromKeyboardEvent(event)
  if (!actual) return false
  return serializeKeyCommandBinding(normalized) === serializeKeyCommandBinding(actual)
}

export const getKeyCommandForEvent = (
  event: KeyboardEvent,
  bindings: KeyCommandBindings
): KeyCommandDefinition | null => {
  for (const definition of KEY_COMMAND_DEFINITIONS) {
    if (keyCommandMatchesEvent(bindings[definition.id], event)) return definition
  }
  return null
}

export const formatKeyCommandBinding = (
  binding: KeyCommandBinding | null | undefined
): string[] => {
  const normalized = normalizeKeyCommandBinding(binding)
  if (!normalized) return ['Unassigned']
  const displayKey =
    normalized.key === 'Escape' ? 'Esc' : normalized.key === 'Space' ? 'Space' : normalized.key
  return [
    ...normalized.modifiers.map((modifier) => {
      if (modifier === PRIMARY_MODIFIER) return 'Cmd/Ctrl'
      if (modifier === SHIFT_MODIFIER) return 'Shift'
      return 'Alt'
    }),
    displayKey
  ]
}

export const findKeyCommandConflict = (
  commandId: KeyCommandId,
  binding: KeyCommandBinding,
  bindings: KeyCommandBindings
): KeyCommandDefinition | null => {
  const serialized = serializeKeyCommandBinding(binding)
  if (!serialized) return null
  return (
    KEY_COMMAND_DEFINITIONS.find(
      (definition) =>
        definition.id !== commandId &&
        serializeKeyCommandBinding(bindings[definition.id]) === serialized
    ) || null
  )
}

export const hasCustomKeyCommandBinding = (
  commandId: KeyCommandId,
  overrides: AppSettings['keyCommandBindings'] | null | undefined
): boolean => Object.prototype.hasOwnProperty.call(overrides || {}, commandId)
