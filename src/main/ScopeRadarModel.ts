import { normalizeCapabilityKey } from './EvidencePackModel'
import type {
  CapabilityMapEntry,
  EvidencePackCapabilityCell,
  ScopeRadarQuestion,
  ScopeRadarResult,
  ScopeRadarSliceKind,
  ScopeRadarSlopBudget
} from './store/types'

const MAX_PROMPT_CHARS = 4000
const MAX_TEXT_CHARS = 600

interface ScopeRadarInput {
  prompt: unknown
  currentState?: unknown
  now?: Date
}

interface SliceSeed {
  key: string
  title: string
  description: string
  kind: ScopeRadarSliceKind
}

function text(value: unknown, max = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function sentenceCase(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return 'Task scope'
  return compact[0].toUpperCase() + compact.slice(1)
}

function deriveDesiredCapability(prompt: string): string {
  const cleaned = prompt
    .replace(/^please\s+/i, '')
    .replace(/^can you\s+/i, '')
    .replace(/^could you\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const firstLine = cleaned.split(/\n+/)[0] || cleaned
  const firstSentence = firstLine.split(/(?<=[.!?])\s+/)[0] || firstLine
  return sentenceCase(firstSentence.replace(/[.!?]+$/g, '').slice(0, 140))
}

function hasUiImportShape(prompt: string): boolean {
  return /\b(ui|interface|view|screen|component|layout|swiftui|react|html|figma)\b/i.test(prompt) &&
    /\b(import|importer|parse|convert|extract|translate|ingest)\b/i.test(prompt)
}

function hasVagueHighLoadShape(prompt: string): boolean {
  return /\b(entire|everything|anything|arbitrary|all|full|complete|one[- ]shot|just|simply|how hard|make my app|whole app)\b/i.test(prompt)
}

function riskLevel(prompt: string): ScopeRadarResult['riskLevel'] {
  let score = 0
  if (prompt.length > 900) score += 1
  if (hasVagueHighLoadShape(prompt)) score += 2
  if (hasUiImportShape(prompt)) score += 2
  if (/\b(no file edits|do not edit|don't ask|walk away|agent transcript)\b/i.test(prompt)) score += 1
  if (score >= 4) return 'high'
  if (score >= 2) return 'medium'
  return 'low'
}

function rootSlice(desiredCapability: string): SliceSeed {
  return {
    key: normalizeCapabilityKey(desiredCapability, 'task-scope'),
    title: desiredCapability,
    description: 'Top-level capability requested by the user; child slices define proof boundaries.',
    kind: 'known'
  }
}

function uiImportSlices(): SliceSeed[] {
  return [
    {
      key: 'source-format-contract',
      title: 'Source format contract',
      description: 'Identify the input UI formats, schema guarantees, and unsupported source shapes.',
      kind: 'prerequisite'
    },
    {
      key: 'parser-normalizer',
      title: 'Parser and normalizer',
      description: 'Convert source UI data into a stable intermediate representation before rendering.',
      kind: 'known'
    },
    {
      key: 'component-mapping',
      title: 'Component mapping',
      description: 'Map imported primitives onto existing app components without inventing a parallel UI system.',
      kind: 'known'
    },
    {
      key: 'style-asset-adaptation',
      title: 'Style and asset adaptation',
      description: 'Translate spacing, typography, colors, images, and missing assets through an explicit adaptation layer.',
      kind: 'unknown'
    },
    {
      key: 'preview-validation',
      title: 'Preview validation',
      description: 'Prove imported UI renders correctly through fixtures, previews, or screenshot checks.',
      kind: 'prerequisite'
    },
    {
      key: 'arbitrary-ui-coverage',
      title: 'Arbitrary UI coverage',
      description: 'General support for every UI shape or framework; treat as speculative until narrowed by fixtures.',
      kind: 'speculative'
    }
  ]
}

function genericSlices(desiredCapability: string): SliceSeed[] {
  const rootKey = normalizeCapabilityKey(desiredCapability, 'task-scope')
  return [
    {
      key: `${rootKey}-boundary`,
      title: 'Scope boundary',
      description: 'Define what is in scope, what is out of scope, and what counts as done.',
      kind: 'prerequisite'
    },
    {
      key: `${rootKey}-repo-fit`,
      title: 'Repository fit',
      description: 'Identify existing files, conventions, tests, and abstractions this task must reuse.',
      kind: 'prerequisite'
    },
    {
      key: `${rootKey}-implementation`,
      title: 'Implementation slice',
      description: 'Smallest implementation path that can move the requested capability forward.',
      kind: 'known'
    },
    {
      key: `${rootKey}-validation`,
      title: 'Validation evidence',
      description: 'Tests, commands, screenshots, or manual checks needed before claiming completion.',
      kind: 'prerequisite'
    }
  ]
}

function mapEntriesFromSlices(
  root: SliceSeed,
  slices: SliceSeed[],
  nowIso: string
): CapabilityMapEntry[] {
  const rootKey = normalizeCapabilityKey(root.key, 'task-scope')
  return [
    {
      key: rootKey,
      title: root.title,
      description: root.description,
      provenance: { state: 'inferred', source: 'scope_radar', at: nowIso }
    },
    ...slices.map((slice) => ({
      key: normalizeCapabilityKey(slice.key, slice.key),
      title: slice.title,
      description: slice.description,
      parentKey: rootKey,
      provenance: { state: 'inferred' as const, source: 'scope_radar' as const, at: nowIso }
    }))
  ]
}

function cellDraftsFromMapEntries(entries: CapabilityMapEntry[]): EvidencePackCapabilityCell[] {
  return entries.map((entry) => ({
    capabilityKey: entry.key,
    title: entry.title,
    status: 'unverified',
    evidenceRefs: [],
    statusReason: 'Scope Radar inferred this slice before implementation evidence was produced.'
  }))
}

function evidenceRequired(prompt: string, uiImport: boolean): string[] {
  const evidence = [
    'Repository files or conventions inspected before edits.',
    'Focused tests, commands, screenshots, or fixture runs that prove the changed capability.',
    'Evidence refs for every completion claim in the final answer.'
  ]
  if (uiImport) {
    evidence.unshift(
      'Named input UI fixture(s) with expected output or preview behavior.',
      'Explicit unsupported input shapes for the importer.'
    )
  }
  if (/\bapi|backend|database|auth\b/i.test(prompt)) {
    evidence.push('API contract or persistence behavior verified with tests or a controlled fixture.')
  }
  return evidence
}

function allowedSurfaces(prompt: string, uiImport: boolean): string[] {
  const surfaces = new Set<string>(['existing tests or fixtures', 'directly related implementation files'])
  if (uiImport) {
    surfaces.add('importer/parser modules')
    surfaces.add('visual editor or preview surface')
    surfaces.add('existing design-system/component mapping code')
  }
  if (/\bcss|style|theme|layout|design\b/i.test(prompt)) {
    surfaces.add('existing style/theme tokens')
  }
  if (/\bdoc|readme|spec\b/i.test(prompt)) {
    surfaces.add('task-local documentation')
  }
  return [...surfaces]
}

function nonGoals(prompt: string, uiImport: boolean): string[] {
  const items = [
    'Broad rewrites outside the named capability.',
    'Placeholder-only completion claims without evidence.'
  ]
  if (uiImport || hasVagueHighLoadShape(prompt)) {
    items.unshift(
      'Arbitrary support for every possible UI framework or source format.',
      'Pixel-perfect conversion without named fixtures and acceptance evidence.'
    )
  }
  return items
}

function questions(prompt: string, currentState: string | undefined, uiImport: boolean): ScopeRadarQuestion[] {
  const out: ScopeRadarQuestion[] = []
  if (uiImport) {
    out.push({
      id: 'source-format',
      question: 'Which UI source format should the first slice import?',
      reason: 'UI import is not a single capability until the source contract is named.'
    })
    out.push({
      id: 'first-fixture',
      question: 'What is the smallest fixture that proves the importer is useful?',
      reason: 'A fixture gives the agent a bounded target and prevents placeholder completion.'
    })
  }
  if (!currentState) {
    out.push({
      id: 'current-state',
      question: 'What currently works, and where does the existing flow fail?',
      reason: 'The harness needs a baseline before it can distinguish progress from churn.'
    })
  }
  if (hasVagueHighLoadShape(prompt)) {
    out.push({
      id: 'done-proof',
      question: 'What evidence would make you comfortable calling this slice done?',
      reason: 'High-load prompts need explicit proof before implementation starts.'
    })
  }
  return out.slice(0, 5)
}

function slopBudget(level: ScopeRadarResult['riskLevel']): ScopeRadarSlopBudget {
  if (level === 'high') {
    return {
      maxNewFiles: 4,
      maxNewAbstractions: 1,
      maxPlaceholderFiles: 0,
      maxBroadStylingChanges: 0,
      maxDuplicatedPatterns: 0,
      note: 'High-load or vague task: prefer extending existing surfaces and require justification for each new abstraction.'
    }
  }
  if (level === 'medium') {
    return {
      maxNewFiles: 6,
      maxNewAbstractions: 2,
      maxPlaceholderFiles: 0,
      maxBroadStylingChanges: 1,
      maxDuplicatedPatterns: 0,
      note: 'Medium-risk task: keep implementation local and tie each new file to a named capability slice.'
    }
  }
  return {
    maxNewFiles: 8,
    maxNewAbstractions: 2,
    maxPlaceholderFiles: 0,
    maxBroadStylingChanges: 1,
    maxDuplicatedPatterns: 0,
    note: 'Low-risk task: keep normal repository conventions and avoid placeholder-only files.'
  }
}

export function buildScopeRadarResult(input: ScopeRadarInput): ScopeRadarResult {
  const prompt = text(input.prompt, MAX_PROMPT_CHARS)
  if (!prompt) throw new Error('Scope Radar requires a non-empty prompt.')
  const currentState = text(input.currentState, 1000)
  const nowIso = (input.now || new Date()).toISOString()
  const desiredCapability = deriveDesiredCapability(prompt)
  const uiImport = hasUiImportShape(prompt)
  const root = rootSlice(desiredCapability)
  const slices = uiImport ? uiImportSlices() : genericSlices(desiredCapability)
  const capabilityMap = mapEntriesFromSlices(root, slices, nowIso)
  const level = riskLevel(prompt)
  const sliceKinds = Object.fromEntries(
    [
      [normalizeCapabilityKey(root.key, 'task-scope'), root.kind],
      ...slices.map((slice) => [normalizeCapabilityKey(slice.key, slice.key), slice.kind])
    ]
  ) as Record<string, ScopeRadarSliceKind>
  return {
    schemaVersion: 1,
    title: `Scope Radar: ${desiredCapability.slice(0, 80)}`,
    prompt,
    riskLevel: level,
    desiredCapability,
    ...(currentState ? { currentState } : {}),
    capabilityMap,
    sliceKinds,
    evidenceRequired: evidenceRequired(prompt, uiImport),
    allowedSurfaces: allowedSurfaces(prompt, uiImport),
    nonGoals: nonGoals(prompt, uiImport),
    questions: questions(prompt, currentState, uiImport),
    slopBudget: slopBudget(level),
    evidencePackDraft: {
      mapEntries: capabilityMap,
      capabilityCells: cellDraftsFromMapEntries(capabilityMap),
      completionClaims: [],
      diffTouchedFiles: []
    }
  }
}
