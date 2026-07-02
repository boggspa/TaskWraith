import { buildScopeRadarResult } from './ScopeRadarModel'
import type {
  PromptTaskAllowedSurface,
  PromptTaskContract,
  PromptTaskMode,
  RepoConventionIndexEntry,
  RepoConventionIndexSnapshot,
  ScopeRadarResult,
  ScopeRadarSliceKind
} from './store/types'

export interface BuildPromptTaskContractInput {
  prompt: unknown
  currentState?: unknown
  repoConventionIndex?: RepoConventionIndexSnapshot
  now?: Date
}

const MAX_SURFACE_PATHS = 10

function text(value: unknown, max = 4000): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function inferMode(prompt: string, radar: ScopeRadarResult): PromptTaskMode {
  if (/\b(release|ship|deploy|publish|production|rollout)\b/i.test(prompt)) return 'release'
  if (/\b(coher|consisten|dedupe|duplicate|slop|cleanup|refactor|architecture|convention)\b/i.test(prompt)) {
    return 'coherence'
  }
  if (/\b(test|harden|stabilize|stabilise|fix|bug|regression|validation|coverage)\b/i.test(prompt)) {
    return 'harden'
  }
  if (radar.riskLevel === 'high' || radar.questions.length > 1) return 'explore'
  return 'build'
}

function surfaceFromScope(label: string): PromptTaskAllowedSurface {
  return {
    label,
    source: 'scope_radar',
    note: 'Inferred from the user prompt before implementation evidence was produced.'
  }
}

function surfaceFromConvention(entry: RepoConventionIndexEntry): PromptTaskAllowedSurface | undefined {
  if (
    entry.kind !== 'component_family' &&
    entry.kind !== 'style_system' &&
    entry.kind !== 'architectural_boundary' &&
    entry.kind !== 'utility' &&
    entry.kind !== 'decision'
  ) {
    return undefined
  }
  return {
    label: entry.title,
    source: 'repo_convention',
    ...(entry.paths?.length ? { paths: entry.paths.slice(0, MAX_SURFACE_PATHS) } : {}),
    conventionEntryIds: [entry.id],
    note: entry.description
  }
}

function dedupeSurfaces(surfaces: PromptTaskAllowedSurface[]): PromptTaskAllowedSurface[] {
  const seen = new Set<string>()
  const out: PromptTaskAllowedSurface[] = []
  for (const surface of surfaces) {
    const key = `${surface.source}|${surface.label.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(surface)
  }
  return out.slice(0, 16)
}

function firstSlice(radar: ScopeRadarResult): { key?: string; title?: string } {
  const entriesByKey = new Map(radar.capabilityMap.map((entry) => [entry.key, entry]))
  const preferredKind: ScopeRadarSliceKind[] = ['prerequisite', 'known', 'unknown', 'speculative']
  for (const kind of preferredKind) {
    const key = Object.entries(radar.sliceKinds).find(([, value]) => value === kind)?.[0]
    if (key) {
      const entry = entriesByKey.get(key)
      if (entry?.parentKey) return { key, title: entry.title }
    }
  }
  const child = radar.capabilityMap.find((entry) => entry.parentKey)
  return child ? { key: child.key, title: child.title } : {}
}

function acceptanceCriteria(radar: ScopeRadarResult): string[] {
  const criteria = [
    `The first implementation slice advances "${radar.desiredCapability}" without claiming speculative coverage.`,
    ...radar.evidenceRequired.map((item) => `Evidence exists for: ${item}`),
    'Every completion claim is backed by an Evidence Pack cell or explicitly caveated.',
    'Coherence Gate has no blocker findings for generated paths or placeholder-only work.'
  ]
  if (radar.questions.length > 0) {
    criteria.unshift('Required scope questions are answered or carried as explicit blockers before implementation.')
  }
  return criteria.slice(0, 10)
}

export function buildPromptTaskContract(
  input: BuildPromptTaskContractInput
): PromptTaskContract {
  const prompt = text(input.prompt)
  if (!prompt) throw new Error('Prompt-to-task normalizer requires a non-empty prompt.')
  const currentState = text(input.currentState, 1000)
  const radar = buildScopeRadarResult({
    prompt,
    currentState,
    now: input.now
  })
  const generatedAt = (input.now || new Date()).toISOString()
  const selectedSlice = firstSlice(radar)
  const conventionSurfaces = (input.repoConventionIndex?.entries || [])
    .map(surfaceFromConvention)
    .filter((surface): surface is PromptTaskAllowedSurface => Boolean(surface))
  return {
    schemaVersion: 1,
    generatedAt,
    prompt,
    ...(currentState ? { currentState } : {}),
    desiredCapability: radar.desiredCapability,
    inferredMode: inferMode(prompt, radar),
    riskLevel: radar.riskLevel,
    capabilityMap: radar.capabilityMap,
    sliceKinds: radar.sliceKinds,
    nonGoals: radar.nonGoals,
    evidenceRequired: radar.evidenceRequired,
    acceptanceCriteria: acceptanceCriteria(radar),
    allowedSurfaces: dedupeSurfaces([
      ...radar.allowedSurfaces.map(surfaceFromScope),
      ...conventionSurfaces
    ]),
    questions: radar.questions,
    slopBudget: radar.slopBudget,
    ...(selectedSlice.key ? { firstSliceKey: selectedSlice.key } : {}),
    ...(selectedSlice.title ? { firstSliceTitle: selectedSlice.title } : {}),
    ...(input.repoConventionIndex
      ? { conventionIndexGeneratedAt: input.repoConventionIndex.generatedAt }
      : {})
  }
}
