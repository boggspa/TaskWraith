export const CHAT_COMPOSER_SELECTION_PROVIDER_METADATA_KEYS = [
  'selectedModelType',
  'customModel',
  'codexReasoningEffort',
  'codexServiceTier',
  'claudeReasoningEffort',
  'claudeFastMode',
  'kimiFastMode',
  'kimiReasoningEffort',
  'kimiThinkingEnabled',
  'grokReasoningEffort',
  'museReasoningEffort',
  'mistralReasoningEffort',
  'devinReasoningEffort',
  'piReasoningEffort',
  'ollamaReasoningEffort',
  'cursorReasoningEffort',
  'cursorFastMode',
  'antigravityReasoningEffort',
  'antigravityUltraTaskSelected',
  'runtimeProfileId',
  'geminiAuthProfileId'
] as const

export const CHAT_COMPOSER_SELECTION_METADATA_KEYS = [
  ...CHAT_COMPOSER_SELECTION_PROVIDER_METADATA_KEYS,
  'approvalMode',
  'permissionPresetId',
  'workflowMode'
] as const
