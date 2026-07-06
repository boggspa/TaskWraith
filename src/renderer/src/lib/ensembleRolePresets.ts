export interface EnsembleRolePreset {
  id: string
  label: string
  description: string
}

export const ENSEMBLE_ROLE_PRESET_CUSTOM = 'custom'

export const ENSEMBLE_ROLE_PRESETS: EnsembleRolePreset[] = [
  { id: 'explorer', label: 'Explorer', description: 'Map the problem, constraints, and safest path' },
  { id: 'architect', label: 'Architect', description: 'Shape structure, interfaces, and tradeoffs' },
  {
    id: 'designer',
    label: 'Designer',
    description:
      'Protect UI/UX quality: extend existing chrome, hierarchy, and interaction patterns while making clear design calls'
  },
  { id: 'planner', label: 'Planner', description: 'Break work into ordered, reviewable steps' },
  { id: 'worker', label: 'Worker', description: 'Execute implementation and concrete changes' },
  { id: 'implementer', label: 'Implementer', description: 'Land the patch with tight, tested diffs' },
  { id: 'reviewer', label: 'Reviewer', description: 'Critique quality, risks, and missing cases' },
  { id: 'debugger', label: 'Debugger', description: 'Trace failures and isolate root causes' },
  { id: 'researcher', label: 'Researcher', description: 'Gather facts, references, and alternatives' },
  { id: 'synthesizer', label: 'Synthesizer', description: 'Merge peer outputs into a coherent answer' },
  { id: 'documentarian', label: 'Documentarian', description: 'Capture decisions, usage, and handoff notes' },
  { id: 'tester', label: 'Tester', description: 'Design checks, repro steps, and verification' }
]

export function resolveRolePresetId(role: string): string {
  const normalized = role.trim().toLowerCase()
  if (!normalized) return ENSEMBLE_ROLE_PRESET_CUSTOM
  const match = ENSEMBLE_ROLE_PRESETS.find((preset) => preset.label.toLowerCase() === normalized)
  return match?.id || ENSEMBLE_ROLE_PRESET_CUSTOM
}

export function roleLabelForPresetId(presetId: string): string | null {
  if (presetId === ENSEMBLE_ROLE_PRESET_CUSTOM) return null
  return ENSEMBLE_ROLE_PRESETS.find((preset) => preset.id === presetId)?.label || null
}
