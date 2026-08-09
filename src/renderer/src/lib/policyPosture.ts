import type {
  AgenticNetworkPolicy,
  AgenticServicePolicy,
  AgenticServicesSettings
} from '../../../main/store/types'

export type PolicyPostureKey =
  | 'shellCommands'
  | 'fileChanges'
  | 'externalPublish'
  | 'mcpTools'
  | 'subThreadDelegation'
  | 'canvasInteraction'
  | 'webBrowsing'
  | 'sketchCanvas'
  | 'mediaEditing'
  | 'networkAccess'

export type PolicyPostureValue = AgenticServicePolicy | AgenticNetworkPolicy
export type PolicyPostureTone = 'ok' | 'watch' | 'risk'

export interface PolicyPostureOption {
  value: PolicyPostureValue
  label: string
}

export interface PolicyPostureRow {
  id: string
  policyKey: PolicyPostureKey
  label: string
  scope: string
  value: PolicyPostureValue
  suggestedValue: PolicyPostureValue
  display: string
  tone: PolicyPostureTone
  description: string
  options: readonly PolicyPostureOption[]
  isSuggested: boolean
}

export const AGENTIC_SERVICE_POLICY_OPTIONS: readonly PolicyPostureOption[] = [
  { value: 'workspace', label: 'Ask, then allow workspace' },
  { value: 'ask', label: 'Ask every time' },
  { value: 'allow', label: 'Always allow' },
  { value: 'deny', label: 'Block' }
]

export const NON_GRANTABLE_AGENTIC_SERVICE_POLICY_OPTIONS: readonly PolicyPostureOption[] = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'deny', label: 'Block' }
]

export const NETWORK_POLICY_OPTIONS: readonly PolicyPostureOption[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Block' }
]

export type SuggestedPolicyPosture = {
  [Key in PolicyPostureKey]-?: NonNullable<AgenticServicesSettings[Key]>
}

export const SUGGESTED_POLICY_POSTURE: Readonly<SuggestedPolicyPosture> = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  externalPublish: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  webBrowsing: 'ask',
  sketchCanvas: 'allow',
  mediaEditing: 'ask',
  networkAccess: 'allow'
}

function policyTone(value: PolicyPostureValue): PolicyPostureTone {
  if (value === 'allow') return 'risk'
  if (value === 'workspace') return 'watch'
  return 'ok'
}

function optionLabel(options: readonly PolicyPostureOption[], value: PolicyPostureValue): string {
  return options.find((option) => option.value === value)?.label ?? value
}

function row(
  settings: AgenticServicesSettings,
  input: Omit<PolicyPostureRow, 'value' | 'suggestedValue' | 'display' | 'tone' | 'isSuggested'>
): PolicyPostureRow {
  const suggestedValue = SUGGESTED_POLICY_POSTURE[input.policyKey]
  const value = settings[input.policyKey] ?? suggestedValue
  return {
    ...input,
    value,
    suggestedValue,
    display: optionLabel(input.options, value),
    tone: policyTone(value),
    isSuggested: value === suggestedValue
  }
}

export function buildPolicyPostureRows(
  settings: AgenticServicesSettings
): readonly PolicyPostureRow[] {
  return [
    row(settings, {
      id: 'shell',
      policyKey: 'shellCommands',
      label: 'Shell commands',
      scope: 'Workspace',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description: 'Provider runs can request terminal commands inside the active workspace.'
    }),
    row(settings, {
      id: 'files',
      policyKey: 'fileChanges',
      label: 'File changes',
      scope: 'Workspace',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description: 'Write, replace, and patch tools stay inside the workspace boundary.'
    }),
    row(settings, {
      id: 'publish',
      policyKey: 'externalPublish',
      label: 'External publishing',
      scope: 'External',
      options: NON_GRANTABLE_AGENTIC_SERVICE_POLICY_OPTIONS,
      description:
        'Agent-routed pushes, pull requests, and release publishing require explicit approval.'
    }),
    row(settings, {
      id: 'mcp',
      policyKey: 'mcpTools',
      label: 'Provider tools',
      scope: 'Provider',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description:
        'TaskWraith provider tools expose workspace, audit, editor, and app-control surfaces.'
    }),
    row(settings, {
      id: 'subthread',
      policyKey: 'subThreadDelegation',
      label: 'Sub-thread delegation',
      scope: 'Provider',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description: 'Agents can spawn or resume provider sub-threads under the current workspace.'
    }),
    row(settings, {
      id: 'canvas',
      policyKey: 'canvasInteraction',
      label: 'Canvas interaction',
      scope: 'Workspace',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description: 'Agents can click and fill preview UI when the workspace policy permits it.'
    }),
    row(settings, {
      id: 'browser',
      policyKey: 'webBrowsing',
      label: 'Browser navigation',
      scope: 'Workspace',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description:
        'Agents can open and navigate websites in the sandboxed Canvas Browser; clicking and typing stay under Canvas interaction.'
    }),
    row(settings, {
      id: 'sketch',
      policyKey: 'sketchCanvas',
      label: 'Sketch Canvas',
      scope: 'Chat',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description:
        'Agents can edit structured shapes and text in chat-owned sketches; opening and reading stay available to read-only seats.'
    }),
    row(settings, {
      id: 'media',
      policyKey: 'mediaEditing',
      label: 'Media editing',
      scope: 'Workspace',
      options: AGENTIC_SERVICE_POLICY_OPTIONS,
      description:
        'Transcode, encode, probe, and mix workspace audio/video files. Denied under read-only.'
    }),
    row(settings, {
      id: 'network',
      policyKey: 'networkAccess',
      label: 'Network access',
      scope: 'Provider',
      options: NETWORK_POLICY_OPTIONS,
      description: 'Provider tool loops may fetch from the network when this is allowed.'
    })
  ]
}

export function summarizePolicyPosture(rows: readonly PolicyPostureRow[]): {
  riskyPolicyCount: number
  watchPolicyCount: number
  overrideCount: number
} {
  return {
    riskyPolicyCount: rows.filter((candidate) => candidate.tone === 'risk').length,
    watchPolicyCount: rows.filter((candidate) => candidate.tone === 'watch').length,
    overrideCount: rows.filter((candidate) => !candidate.isSuggested).length
  }
}

export function applyPolicyPostureOverride(
  settings: AgenticServicesSettings,
  key: PolicyPostureKey,
  value: PolicyPostureValue
): AgenticServicesSettings {
  if (key === 'networkAccess') {
    return { ...settings, networkAccess: value as AgenticNetworkPolicy }
  }
  return { ...settings, [key]: value as AgenticServicePolicy }
}
