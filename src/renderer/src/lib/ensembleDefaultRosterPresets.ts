import type { EnsembleStageRole, ProviderId } from '../../../main/store/types'
import {
  MAX_ROSTER_PRESET_PARTICIPANTS,
  type EnsembleRosterParticipantSnapshot,
  type EnsembleRosterPreset
} from '../../../main/EnsembleRosterPresetContract'
import { isEnsembleSeatProvider } from '../../../shared/retiredProviders'
import { getDefaultEnsembleParticipantConfig } from './ensembleProviderDefaults'

export const DEFAULT_ENSEMBLE_ROSTER_SIZES = [3, 4, 5, 6, 8, 10] as const

type DefaultRosterSize = (typeof DEFAULT_ENSEMBLE_ROSTER_SIZES)[number]
type DefaultRosterRoleName =
  | 'Orchestrator'
  | 'Advisor'
  | 'Boardmaster'
  | 'Scout1'
  | 'Scout2'
  | 'Work1'
  | 'Work2'
  | 'Work3'
  | 'Challenge1'
  | 'Challenge2'

type DefaultRosterRoleDefinition = {
  role: DefaultRosterRoleName
  group: 'Management' | 'Recon Scouts' | 'Worker Captains' | 'Review Challengers'
  summary: string
  stageRole?: EnsembleStageRole
  captain?: boolean
}

const ROLE_DEFINITIONS: Record<DefaultRosterRoleName, DefaultRosterRoleDefinition> = {
  Orchestrator: {
    role: 'Orchestrator',
    group: 'Management',
    summary: 'Orchestrates fan-out, yields, task routing, and final delivery.'
  },
  Advisor: {
    role: 'Advisor',
    group: 'Management',
    summary: 'Reconciles findings, advises the Orchestrator, and synthesises decisions.',
    captain: true
  },
  Boardmaster: {
    role: 'Boardmaster',
    group: 'Management',
    summary: 'Maintains the blackboard, ToDos, dependencies, and goal state.',
    captain: true
  },
  Scout1: {
    role: 'Scout1',
    group: 'Recon Scouts',
    summary: 'Surveys the task, gathers evidence, and reports constraints early.',
    stageRole: 'scout'
  },
  Scout2: {
    role: 'Scout2',
    group: 'Recon Scouts',
    summary: 'Runs independent reconnaissance and checks Scout1 assumptions.',
    stageRole: 'scout'
  },
  Work1: {
    role: 'Work1',
    group: 'Worker Captains',
    summary: 'Owns the primary workstream and returns concrete, verified output.',
    stageRole: 'worker'
  },
  Work2: {
    role: 'Work2',
    group: 'Worker Captains',
    summary: 'Owns a second independent workstream and coordinates its hand-offs.',
    stageRole: 'worker'
  },
  Work3: {
    role: 'Work3',
    group: 'Worker Captains',
    summary: 'Owns overflow or specialist work and closes remaining execution gaps.',
    stageRole: 'worker'
  },
  Challenge1: {
    role: 'Challenge1',
    group: 'Review Challengers',
    summary: 'Challenges assumptions, reviews outputs, and demands supporting evidence.',
    stageRole: 'reviewer'
  },
  Challenge2: {
    role: 'Challenge2',
    group: 'Review Challengers',
    summary: 'Runs an independent final challenge for missed risks and regressions.',
    stageRole: 'reviewer'
  }
}

const DEFAULT_ROSTER_VARIANTS: ReadonlyArray<{
  size: DefaultRosterSize
  name: string
  roles: readonly DefaultRosterRoleName[]
}> = [
  { size: 3, name: '3-seat Core', roles: ['Orchestrator', 'Advisor', 'Work1'] },
  {
    size: 4,
    name: '4-seat Review',
    roles: ['Orchestrator', 'Advisor', 'Work1', 'Challenge1']
  },
  {
    size: 5,
    name: '5-seat Balanced',
    roles: ['Orchestrator', 'Advisor', 'Scout1', 'Work1', 'Challenge1']
  },
  {
    size: 6,
    name: '6-seat Delivery',
    roles: ['Orchestrator', 'Advisor', 'Scout1', 'Work1', 'Work2', 'Challenge1']
  },
  {
    size: 8,
    name: '8-seat Extended',
    roles: [
      'Orchestrator',
      'Advisor',
      'Boardmaster',
      'Scout1',
      'Scout2',
      'Work1',
      'Work2',
      'Challenge1'
    ]
  },
  {
    size: 10,
    name: '10-seat Full Panel',
    roles: [
      'Orchestrator',
      'Advisor',
      'Boardmaster',
      'Scout1',
      'Scout2',
      'Work1',
      'Work2',
      'Work3',
      'Challenge1',
      'Challenge2'
    ]
  }
]

function availableProviders(providerIds: readonly ProviderId[]): ProviderId[] {
  const seen = new Set<ProviderId>()
  return providerIds.filter((provider) => {
    if (!isEnsembleSeatProvider(provider) || seen.has(provider)) return false
    seen.add(provider)
    return true
  })
}

function panelBrief(
  roles: readonly DefaultRosterRoleDefinition[],
  assignedRole: DefaultRosterRoleDefinition
): string {
  const lines = [
    "Coordinate this provider-agnostic panel around the user's current goal. Share evidence, make hand-offs explicit, and stay within the assigned role."
  ]
  for (const group of [
    'Management',
    'Recon Scouts',
    'Worker Captains',
    'Review Challengers'
  ] as const) {
    const members = roles.filter((role) => role.group === group)
    if (members.length === 0) continue
    lines.push('', `${group}:`, ...members.map((role) => `@${role.role} - ${role.summary}`))
  }
  lines.push('', `Your assignment: @${assignedRole.role}. ${assignedRole.summary}`)
  return lines.join('\n')
}

function participantSnapshot(
  role: DefaultRosterRoleDefinition,
  roles: readonly DefaultRosterRoleDefinition[],
  provider: ProviderId,
  order: number
): EnsembleRosterParticipantSnapshot {
  const defaults = getDefaultEnsembleParticipantConfig(provider)
  return {
    provider,
    enabled: true,
    role: role.role,
    instructions: panelBrief(roles, role),
    order,
    ...(role.role === 'Orchestrator' ? { isBossman: true } : {}),
    ...(role.captain ? { isSecondInCommand: true } : {}),
    model: defaults.model,
    permissionPresetId: 'default',
    ...(role.stageRole ? { stageRole: role.stageRole } : {}),
    ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    ...(typeof defaults.fastModeEnabled === 'boolean'
      ? { fastModeEnabled: defaults.fastModeEnabled }
      : {}),
    ...(typeof defaults.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: defaults.thinkingEnabled }
      : {}),
    ...(defaults.serviceTier ? { serviceTier: defaults.serviceTier } : {})
  }
}

/**
 * Build the editable JSON-shaped roster defaults for a fresh install. Provider
 * rows are drawn exclusively from the main-owned configured-provider snapshot;
 * when the panel is larger than that set, providers repeat round-robin with
 * their own current model defaults instead of inventing an unavailable seat.
 */
export function buildDefaultEnsembleRosterPresets(
  providerIds: readonly ProviderId[],
  now = Date.now()
): EnsembleRosterPreset[] {
  const providers = availableProviders(providerIds)
  if (providers.length === 0) return []

  return DEFAULT_ROSTER_VARIANTS.map((variant) => {
    const roles = variant.roles.map((role) => ROLE_DEFINITIONS[role])
    return {
      id: `ensemble-roster-default-${variant.size}`,
      name: variant.name,
      createdAt: now,
      updatedAt: now,
      orchestrationMode: 'continuous',
      maxParticipants: MAX_ROSTER_PRESET_PARTICIPANTS,
      maxContinuationHops: 6,
      fanoutPolicy: 'read_only',
      concurrentModeEnabled: true,
      participants: roles.map((role, index) =>
        participantSnapshot(role, roles, providers[index % providers.length], index + 1)
      )
    }
  })
}
