import type {
  AuditEvidenceRef,
  CoherenceGateFinding,
  CoherenceGateResult,
  EvidencePackRecord,
  RepoConventionIndexEntry,
  RepoConventionIndexSnapshot,
  ScopeRadarResult,
  ScopeRadarSlopBudget
} from './store/types'

export interface CoherenceGateFileInput {
  path: string
  status?: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'
  isPlaceholder?: boolean
}

export interface BuildCoherenceGateInput {
  touchedFiles?: ReadonlyArray<string | CoherenceGateFileInput>
  changedFiles?: ReadonlyArray<string | CoherenceGateFileInput>
  newFiles?: ReadonlyArray<string | CoherenceGateFileInput>
  placeholderFiles?: ReadonlyArray<string | CoherenceGateFileInput>
  validationEvidenceRefs?: ReadonlyArray<AuditEvidenceRef>
  validationCommands?: ReadonlyArray<string>
  evidencePack?: Pick<
    EvidencePackRecord,
    'capabilityCells' | 'completionClaims' | 'diffTouchedFiles'
  >
  scopeRadar?: ScopeRadarResult
  repoConventionIndex?: RepoConventionIndexSnapshot
  now?: Date
}

const MAX_FINDING_PATHS = 20

const DEFAULT_SLOP_BUDGET: ScopeRadarSlopBudget = {
  maxNewFiles: 6,
  maxNewAbstractions: 2,
  maxPlaceholderFiles: 0,
  maxBroadStylingChanges: 1,
  maxDuplicatedPatterns: 1,
  note: 'Default Coherence Gate budget used because no Scope Radar budget was supplied.'
}

const GENERATED_SEGMENTS = new Set([
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.vite',
  '.turbo',
  'node_modules',
  '.swiftpm',
  'DerivedData',
  '.gradle',
  'target',
  'out'
])

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/g, '')
}

function pathFromInput(value: string | CoherenceGateFileInput): string | undefined {
  const raw = typeof value === 'string' ? value : value.path
  const normalized = normalizePath(raw || '')
  return normalized || undefined
}

function uniqueSorted(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].map((value) => normalizePath(value || '')).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  )
}

function boundedPaths(paths: string[]): string[] {
  return paths.slice(0, MAX_FINDING_PATHS)
}

function inputsToPaths(values?: ReadonlyArray<string | CoherenceGateFileInput>): string[] {
  return uniqueSorted((values || []).map(pathFromInput))
}

function addedPaths(values?: ReadonlyArray<string | CoherenceGateFileInput>): string[] {
  return uniqueSorted(
    (values || []).map((value) => {
      if (typeof value === 'string') return undefined
      return value.status === 'added' ? pathFromInput(value) : undefined
    })
  )
}

function placeholderInputPaths(
  values?: ReadonlyArray<string | CoherenceGateFileInput>,
  includeStringValues = true
): string[] {
  return uniqueSorted(
    (values || []).map((value) => {
      if (typeof value === 'string') return includeStringValues ? value : undefined
      return value.isPlaceholder ? value.path : undefined
    })
  )
}

function pathLooksPlaceholder(path: string): boolean {
  return /(^|[/_.-])(placeholder|stub|todo|wip|dummy|temp)([/_.-]|$)/i.test(path)
}

function pathLooksStyle(path: string): boolean {
  return (
    /\.(css|scss|sass|less)$/.test(path) ||
    /(^|[/_.-])(theme|tokens?|styles?|design-system|tailwind|postcss)([/_.-]|$)/i.test(path)
  )
}

function pathLooksTestOrFixture(path: string): boolean {
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|swift|py)$/.test(path) ||
    /(^|\/)(__tests__|tests?|fixtures?|snapshots?|screenshots?|stories)(\/|$)/i.test(path) ||
    /\.(stories)\.(ts|tsx|js|jsx)$/.test(path)
  )
}

function pathLooksDocOnly(path: string): boolean {
  return /\.(md|mdx|txt|rst)$/.test(path) || /(^|\/)(docs?|changelog)(\/|$)/i.test(path)
}

function pathLooksImplementation(path: string): boolean {
  return /\.(ts|tsx|js|jsx|swift|py|go|rs|java|kt|rb|php|c|cpp|h|hpp)$/.test(path)
}

function pathLooksNewAbstraction(path: string): boolean {
  const basename = path.split('/').at(-1) || path
  return (
    /(?:Manager|Service|Provider|Adapter|Factory|Controller|Helper|Util|Store|Registry|Mapper|Orchestrator)\.(ts|tsx|js|jsx|swift|py)$/i.test(
      basename
    ) ||
    /(^|[/_.-])(managers?|services?|providers?|adapters?|factories|controllers?|helpers?|utils?|stores?|registries|mappers?|orchestrators?)([/_.-]|$)/i.test(
      path
    )
  )
}

function pathHasGeneratedSegment(path: string): boolean {
  return path.split('/').some((segment) => GENERATED_SEGMENTS.has(segment))
}

function matchesConventionPath(path: string, conventionPath: string): boolean {
  const normalizedConvention = normalizePath(conventionPath)
  return path === normalizedConvention || path.startsWith(`${normalizedConvention}/`)
}

function generatedConventionHits(
  touchedPaths: string[],
  entries: RepoConventionIndexEntry[]
): { paths: string[]; entryIds: string[] } {
  const generatedEntries = entries.filter((entry) => entry.kind === 'generated_path')
  const hitEntryIds = new Set<string>()
  const hits = touchedPaths.filter((path) => {
    if (pathHasGeneratedSegment(path)) return true
    return generatedEntries.some((entry) => {
      const matched = (entry.paths || []).some((conventionPath) =>
        matchesConventionPath(path, conventionPath)
      )
      if (matched) hitEntryIds.add(entry.id)
      return matched
    })
  })
  return {
    paths: uniqueSorted(hits),
    entryIds: [...hitEntryIds].sort((a, b) => a.localeCompare(b))
  }
}

function surfaceAllowsStyle(scopeRadar?: ScopeRadarResult): boolean {
  if (!scopeRadar) return false
  return scopeRadar.allowedSurfaces.some((surface) => /style|theme|token|design/i.test(surface))
}

function surfaceMatchesPath(surface: string, path: string): boolean {
  const normalizedSurface = surface.toLowerCase()
  if (/tests?|fixtures?/.test(normalizedSurface)) return pathLooksTestOrFixture(path)
  if (/documentation|docs?/.test(normalizedSurface)) return pathLooksDocOnly(path)
  if (/importer|parser|normalizer|convert|ingest/.test(normalizedSurface)) {
    return /import|parser?|normaliz|convert|ingest|ir/i.test(path)
  }
  if (/visual editor|preview|canvas/.test(normalizedSurface)) {
    return /visual|editor|preview|canvas|component|ui/i.test(path)
  }
  if (/design-system|component mapping|component/.test(normalizedSurface)) {
    return /component|design-system|theme|style|token|ui/i.test(path)
  }
  if (/style|theme|token/.test(normalizedSurface)) return pathLooksStyle(path)
  if (/implementation/.test(normalizedSurface)) return pathLooksImplementation(path)
  return false
}

function hasAllowedSurfaceMatch(path: string, scopeRadar: ScopeRadarResult): boolean {
  return scopeRadar.allowedSurfaces.some((surface) => surfaceMatchesPath(surface, path))
}

function validationRefsFromEvidencePack(
  evidencePack?: BuildCoherenceGateInput['evidencePack']
): AuditEvidenceRef[] {
  if (!evidencePack) return []
  return [
    ...evidencePack.capabilityCells.flatMap((cell) => cell.evidenceRefs || []),
    ...evidencePack.completionClaims.flatMap((claim) => claim.evidenceRefs || [])
  ]
}

function validationCommandsFromEvidencePack(
  evidencePack?: BuildCoherenceGateInput['evidencePack']
): string[] {
  if (!evidencePack) return []
  return evidencePack.capabilityCells
    .map((cell) => cell.validationCommand || '')
    .filter((command) => command.trim())
}

function evidenceRefLooksValidation(ref: AuditEvidenceRef): boolean {
  return pathLooksTestOrFixture(ref.path || '') || /test|fixture|screenshot|preview|verified/i.test(ref.note || '')
}

function makeSummary(result: {
  blockers: number
  warnings: number
  touchedCount: number
}): string {
  if (result.blockers > 0) {
    return `Coherence Gate blocked: ${result.blockers} blocker(s), ${result.warnings} warning(s), ${result.touchedCount} touched file(s).`
  }
  if (result.warnings > 0) {
    return `Coherence Gate warns: ${result.warnings} warning(s), ${result.touchedCount} touched file(s).`
  }
  return `Coherence Gate passed: ${result.touchedCount} touched file(s), no deterministic coherence issues found.`
}

export function buildCoherenceGateResult(input: BuildCoherenceGateInput): CoherenceGateResult {
  const generatedAt = (input.now || new Date()).toISOString()
  const evidencePackTouchedFiles = input.evidencePack?.diffTouchedFiles || []
  const touchedFiles = uniqueSorted([
    ...inputsToPaths(input.touchedFiles),
    ...inputsToPaths(input.changedFiles),
    ...evidencePackTouchedFiles
  ])
  const newFiles = uniqueSorted([
    ...inputsToPaths(input.newFiles),
    ...addedPaths(input.touchedFiles),
    ...addedPaths(input.changedFiles)
  ])
  const placeholderFiles = uniqueSorted([
    ...placeholderInputPaths(input.placeholderFiles),
    ...placeholderInputPaths(input.touchedFiles, false),
    ...placeholderInputPaths(input.changedFiles, false),
    ...touchedFiles.filter(pathLooksPlaceholder)
  ])
  const slopBudget = input.scopeRadar?.slopBudget || DEFAULT_SLOP_BUDGET
  const findings: CoherenceGateFinding[] = []
  const conventionEntries = input.repoConventionIndex?.entries || []

  if (touchedFiles.length > 0 && !input.repoConventionIndex) {
    findings.push({
      kind: 'repo_convention_missing',
      severity: 'warning',
      title: 'Repo convention index is missing',
      detail:
        'Coherence Gate could not compare the diff against project conventions. Run repo_convention_scan before trusting broad edits.'
    })
  }

  const generatedHits = generatedConventionHits(touchedFiles, conventionEntries)
  if (generatedHits.paths.length > 0) {
    findings.push({
      kind: 'generated_path_edit',
      severity: 'blocker',
      title: 'Generated or dependency path edited',
      detail:
        'Agents should not edit generated/dependency output unless the task explicitly targets build artifacts.',
      paths: boundedPaths(generatedHits.paths),
      ...(generatedHits.entryIds.length ? { conventionEntryIds: generatedHits.entryIds } : {})
    })
  }

  if (newFiles.length > slopBudget.maxNewFiles) {
    findings.push({
      kind: 'slop_budget_exceeded',
      severity: 'warning',
      title: 'New file budget exceeded',
      detail: `This diff adds ${newFiles.length} file(s), above the Scope Radar budget of ${slopBudget.maxNewFiles}.`,
      paths: boundedPaths(newFiles)
    })
  }

  if (placeholderFiles.length > 0) {
    findings.push({
      kind: 'placeholder_only_work',
      severity: placeholderFiles.length > slopBudget.maxPlaceholderFiles ? 'blocker' : 'warning',
      title: 'Placeholder-looking files touched',
      detail: `This diff touches ${placeholderFiles.length} placeholder/stub-looking file(s). Placeholder-only work cannot support completion claims without explicit evidence.`,
      paths: boundedPaths(placeholderFiles)
    })
  }

  const stylePaths = touchedFiles.filter(pathLooksStyle)
  if (
    stylePaths.length > slopBudget.maxBroadStylingChanges ||
    (stylePaths.length > 0 && !surfaceAllowsStyle(input.scopeRadar))
  ) {
    findings.push({
      kind: 'broad_styling_drift',
      severity: 'warning',
      title: 'Styling surface changed outside the expected budget',
      detail: `This diff touches ${stylePaths.length} styling/theme file(s). Broad style changes should reuse the existing design system and be explicitly in scope.`,
      paths: boundedPaths(stylePaths),
      conventionEntryIds: conventionEntries
        .filter((entry) => entry.kind === 'style_system')
        .map((entry) => entry.id)
    })
  }

  const abstractionRiskPaths = newFiles.filter(pathLooksNewAbstraction)
  if (abstractionRiskPaths.length > 0) {
    findings.push({
      kind: 'duplicate_abstraction_risk',
      severity:
        abstractionRiskPaths.length > slopBudget.maxDuplicatedPatterns ? 'warning' : 'info',
      title: 'New abstraction may duplicate existing patterns',
      detail: `This diff adds ${abstractionRiskPaths.length} abstraction-shaped file(s). Search existing helpers/components before adding a parallel layer.`,
      paths: boundedPaths(abstractionRiskPaths),
      conventionEntryIds: conventionEntries
        .filter((entry) => entry.kind === 'component_family' || entry.kind === 'utility')
        .map((entry) => entry.id)
    })
  }

  if (input.scopeRadar && touchedFiles.length > 0) {
    const implementationTouchedFiles = touchedFiles.filter(
      (file) => !pathLooksDocOnly(file) && !pathLooksTestOrFixture(file)
    )
    const unmatched = implementationTouchedFiles.filter(
      (file) => !hasAllowedSurfaceMatch(file, input.scopeRadar as ScopeRadarResult)
    )
    if (implementationTouchedFiles.length > 0 && unmatched.length === implementationTouchedFiles.length) {
      findings.push({
        kind: 'scope_surface_mismatch',
        severity: 'warning',
        title: 'Touched files do not match inferred allowed surfaces',
        detail:
          'The diff appears outside the surfaces Scope Radar expected for this task. Re-check task scope before continuing.',
        paths: boundedPaths(unmatched),
        capabilityKeys: input.scopeRadar.capabilityMap.map((entry) => entry.key)
      })
    }
  }

  const validationRefs = [
    ...(input.validationEvidenceRefs || []),
    ...validationRefsFromEvidencePack(input.evidencePack)
  ]
  const validationCommands = [
    ...(input.validationCommands || []).filter((command) => command.trim()),
    ...validationCommandsFromEvidencePack(input.evidencePack)
  ]
  const hasValidationEvidence =
    validationCommands.length > 0 ||
    validationRefs.some(evidenceRefLooksValidation) ||
    touchedFiles.some(pathLooksTestOrFixture)
  const nonDocTouchedFiles = touchedFiles.filter((file) => !pathLooksDocOnly(file))
  if (nonDocTouchedFiles.length > 0 && !hasValidationEvidence) {
    findings.push({
      kind: 'missing_validation_evidence',
      severity: 'warning',
      title: 'No validation evidence supplied',
      detail:
        'The diff touches non-documentation files but has no test command, fixture, screenshot, or validation evidence ref. Completion claims should be caveated.',
      paths: boundedPaths(nonDocTouchedFiles)
    })
  }

  const counts = {
    touchedFiles: touchedFiles.length,
    newFiles: newFiles.length,
    placeholderFiles: placeholderFiles.length,
    broadStylingChanges: stylePaths.length,
    duplicatePatternRisks: abstractionRiskPaths.length,
    validationEvidenceRefs: validationRefs.length
  }
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const status = blockers > 0 ? 'block' : warnings > 0 ? 'warn' : 'pass'

  return {
    schemaVersion: 1,
    generatedAt,
    status,
    summary: makeSummary({ blockers, warnings, touchedCount: touchedFiles.length }),
    findings,
    counts,
    slopBudget,
    ...(input.scopeRadar
      ? {
          desiredCapability: input.scopeRadar.desiredCapability,
          scopeRiskLevel: input.scopeRadar.riskLevel
        }
      : {}),
    ...(input.repoConventionIndex
      ? { conventionIndexGeneratedAt: input.repoConventionIndex.generatedAt }
      : {})
  }
}
