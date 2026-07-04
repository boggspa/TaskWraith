import {
  ENSEMBLE_ROLE_PRESETS,
  type EnsembleRolePreset
} from './ensembleRolePresets'

const STORAGE_KEY = 'taskwraith-ensemble-brief-presets'
const MAX_BRIEF_PRESET_NAME_CHARS = 80
const MAX_BRIEF_PRESET_TEXT_CHARS = 4000

export type EnsembleBriefPresetSource = 'role' | 'user'

export interface EnsembleBriefPreset {
  id: string
  name: string
  brief: string
  source: EnsembleBriefPresetSource
  createdAt?: number
  updatedAt?: number
  rolePresetId?: string
}

interface StoredBriefPreset {
  id: string
  name: string
  brief: string
  createdAt: number
  updatedAt: number
}

function newBriefPresetId(now: number): string {
  return `ensemble-brief-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_BRIEF_PRESET_NAME_CHARS)
}

function sanitizeBrief(brief: string): string {
  return brief.trim().slice(0, MAX_BRIEF_PRESET_TEXT_CHARS)
}

function rolePresetToBriefPreset(preset: EnsembleRolePreset): EnsembleBriefPreset {
  return {
    id: `role:${preset.id}`,
    name: preset.label,
    brief: preset.description,
    source: 'role',
    rolePresetId: preset.id
  }
}

export const BUILT_IN_ENSEMBLE_BRIEF_PRESETS: EnsembleBriefPreset[] =
  ENSEMBLE_ROLE_PRESETS.map(rolePresetToBriefPreset)

function isStoredBriefPreset(value: unknown): value is StoredBriefPreset {
  if (!value || typeof value !== 'object') return false
  const entry = value as StoredBriefPreset
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.name === 'string' &&
    entry.name.trim().length > 0 &&
    typeof entry.brief === 'string' &&
    entry.brief.trim().length > 0 &&
    typeof entry.createdAt === 'number' &&
    typeof entry.updatedAt === 'number'
  )
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readStoredBriefPresets(): StoredBriefPreset[] {
  const storage = getStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isStoredBriefPreset)
      .map((preset) => ({
        ...preset,
        name: sanitizeName(preset.name),
        brief: sanitizeBrief(preset.brief)
      }))
      .filter((preset) => preset.name && preset.brief)
  } catch {
    return []
  }
}

function writeStoredBriefPresets(presets: StoredBriefPreset[]): void {
  const storage = getStorage()
  if (!storage) return
  storage.setItem(STORAGE_KEY, JSON.stringify(presets))
}

const briefPresetListeners = new Set<() => void>()
let storageBridgeInstalled = false

function notifyBriefPresetListeners(): void {
  for (const listener of [...briefPresetListeners]) {
    try {
      listener()
    } catch {
      // Listener failures should never break preset persistence.
    }
  }
}

function ensureStorageBridge(): void {
  if (storageBridgeInstalled) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  storageBridgeInstalled = true
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return
    if (event.key !== STORAGE_KEY || event.newValue === null) return
    notifyBriefPresetListeners()
  })
}

export function subscribeEnsembleBriefPresets(listener: () => void): () => void {
  ensureStorageBridge()
  briefPresetListeners.add(listener)
  return () => {
    briefPresetListeners.delete(listener)
  }
}

export function listUserEnsembleBriefPresets(): EnsembleBriefPreset[] {
  return readStoredBriefPresets()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((preset) => ({
      ...preset,
      source: 'user'
    }))
}

export function listEnsembleBriefPresets(): EnsembleBriefPreset[] {
  return [...BUILT_IN_ENSEMBLE_BRIEF_PRESETS, ...listUserEnsembleBriefPresets()]
}

export function getEnsembleBriefPreset(id: string): EnsembleBriefPreset | null {
  return listEnsembleBriefPresets().find((preset) => preset.id === id) ?? null
}

export function saveUserEnsembleBriefPreset(name: string, brief: string): EnsembleBriefPreset {
  const trimmedName = sanitizeName(name)
  const trimmedBrief = sanitizeBrief(brief)
  if (!trimmedName) throw new Error('Brief preset name is required.')
  if (!trimmedBrief) throw new Error('Brief preset text is required.')
  const now = Date.now()
  const preset: StoredBriefPreset = {
    id: newBriefPresetId(now),
    name: trimmedName,
    brief: trimmedBrief,
    createdAt: now,
    updatedAt: now
  }
  const presets = readStoredBriefPresets()
  presets.unshift(preset)
  writeStoredBriefPresets(presets)
  notifyBriefPresetListeners()
  return { ...preset, source: 'user' }
}

export function renameUserEnsembleBriefPreset(
  id: string,
  name: string
): EnsembleBriefPreset | null {
  const trimmedName = sanitizeName(name)
  if (!trimmedName) return null
  const presets = readStoredBriefPresets()
  const index = presets.findIndex((preset) => preset.id === id)
  if (index < 0) return null
  const next: StoredBriefPreset = {
    ...presets[index],
    name: trimmedName,
    updatedAt: Date.now()
  }
  presets[index] = next
  writeStoredBriefPresets(presets)
  notifyBriefPresetListeners()
  return { ...next, source: 'user' }
}

