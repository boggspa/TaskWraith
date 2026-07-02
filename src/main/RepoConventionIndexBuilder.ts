import type {
  RepoConventionIndexEntry,
  RepoConventionIndexSnapshot
} from './store/types'

export interface RepoConventionFile {
  path: string
  kind?: 'file' | 'directory'
}

export interface BuildRepoConventionIndexInput {
  workspaceId: string
  workspacePath?: string
  files: ReadonlyArray<RepoConventionFile | string>
  now?: Date
}

export interface RepoConventionScanSummary {
  fileCount: number
  entryCount: number
  truncated: boolean
}

const MAX_ENTRY_PATHS = 24
const DEFAULT_GENERATED_SEGMENTS = new Set([
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

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map(normalizePath).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function evidence(paths: string[]) {
  return paths.slice(0, MAX_ENTRY_PATHS).map((path) => ({ path }))
}

function entry(
  id: string,
  kind: RepoConventionIndexEntry['kind'],
  title: string,
  paths: string[],
  updatedAt: string,
  description?: string
): RepoConventionIndexEntry {
  const boundedPaths = paths.slice(0, MAX_ENTRY_PATHS)
  return {
    id,
    kind,
    title,
    ...(description ? { description } : {}),
    ...(boundedPaths.length ? { paths: boundedPaths, evidenceRefs: evidence(boundedPaths) } : {}),
    provenance: 'scan',
    updatedAt
  }
}

function includesAny(paths: string[], names: string[]): string[] {
  const nameSet = new Set(names)
  return paths.filter((path) => nameSet.has(path.split('/').at(-1) || path))
}

function detectPackageManagers(paths: string[], updatedAt: string): RepoConventionIndexEntry[] {
  const entries: RepoConventionIndexEntry[] = []
  const npm = includesAny(paths, ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'])
  if (npm.length) {
    entries.push(entry(
      'package-manager-node',
      'decision',
      'Node package metadata and scripts are part of the repo contract',
      npm,
      updatedAt,
      'Prefer existing package scripts and dependency management files before adding new tooling.'
    ))
  }
  const swift = includesAny(paths, ['Package.swift'])
  if (swift.length || paths.some((path) => path.endsWith('.xcodeproj/project.pbxproj'))) {
    entries.push(entry(
      'package-manager-swift',
      'decision',
      'Swift package or Xcode project conventions are present',
      uniqueSorted([...swift, ...paths.filter((path) => path.endsWith('.xcodeproj/project.pbxproj'))]),
      updatedAt,
      'Use the existing Swift package/project layout and documented build gates.'
    ))
  }
  const python = includesAny(paths, ['pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock'])
  if (python.length) {
    entries.push(entry(
      'package-manager-python',
      'decision',
      'Python environment metadata is present',
      python,
      updatedAt,
      'Reuse existing Python tooling instead of adding parallel dependency managers.'
    ))
  }
  return entries
}

function detectFrameworks(paths: string[], updatedAt: string): RepoConventionIndexEntry[] {
  const entries: RepoConventionIndexEntry[] = []
  const reactSignals = paths.filter((path) => /\.(tsx|jsx)$/.test(path)).slice(0, MAX_ENTRY_PATHS)
  if (reactSignals.length) {
    entries.push(entry(
      'component-family-react',
      'component_family',
      'React component files are part of the UI surface',
      reactSignals,
      updatedAt,
      'Prefer established React component and hook patterns before introducing a parallel UI abstraction.'
    ))
  }
  const swiftUiSignals = paths.filter((path) => path.endsWith('.swift') && /View\.swift$|Views\.swift$|UI\//.test(path))
  if (swiftUiSignals.length) {
    entries.push(entry(
      'component-family-swiftui',
      'component_family',
      'SwiftUI view files are part of the UI surface',
      swiftUiSignals,
      updatedAt,
      'Keep iOS UI changes inside the existing SwiftUI module/layout conventions.'
    ))
  }
  const electronSignals = paths.filter((path) =>
    path.startsWith('src/main/') || path.startsWith('src/preload/') || path.startsWith('src/renderer/')
  )
  if (electronSignals.length) {
    entries.push(entry(
      'architectural-boundary-electron',
      'architectural_boundary',
      'Electron main/preload/renderer boundaries are explicit',
      uniqueSorted(electronSignals.map((path) => path.split('/').slice(0, 3).join('/'))),
      updatedAt,
      'Respect process boundaries: main owns host state, preload owns IPC surface, renderer owns UI.'
    ))
  }
  return entries
}

function detectTests(paths: string[], updatedAt: string): RepoConventionIndexEntry[] {
  const tests = paths.filter((path) =>
    /\.test\.(ts|tsx|js|jsx|swift)$/.test(path) ||
    path.includes('/__tests__/') ||
    path.includes('/Tests/')
  )
  if (!tests.length) return []
  return [
    entry(
      'test-convention-nearby',
      'decision',
      'Tests are discoverable in existing test files and test folders',
      tests,
      updatedAt,
      'Add or update focused tests near the touched behavior instead of relying on transcript assertions.'
    )
  ]
}

function detectStyleSystems(paths: string[], updatedAt: string): RepoConventionIndexEntry[] {
  const css = paths.filter((path) => /\.(css|scss|sass|less)$/.test(path))
  const theme = paths.filter((path) =>
    /theme|tokens|style|design-system|tailwind|postcss/i.test(path)
  )
  const stylePaths = uniqueSorted([...css, ...theme])
  if (!stylePaths.length) return []
  return [
    entry(
      'style-system-existing-assets',
      'style_system',
      'Existing style assets define the visual system',
      stylePaths,
      updatedAt,
      'Reuse existing theme tokens, CSS modules, and style files before adding broad styling surfaces.'
    )
  ]
}

function detectGeneratedPaths(paths: string[], updatedAt: string): RepoConventionIndexEntry[] {
  const generated = paths.filter((path) => path.split('/').some((segment) => DEFAULT_GENERATED_SEGMENTS.has(segment)))
  if (!generated.length) return []
  return [
    entry(
      'generated-paths-avoid-editing',
      'generated_path',
      'Generated or dependency output paths should not be edited by agents',
      generated,
      updatedAt,
      'Treat these paths as generated/dependency output unless the task explicitly targets build artifacts.'
    )
  ]
}

function detectArchitecturalBoundaries(paths: string[], updatedAt: string): RepoConventionIndexEntry[] {
  const topLevelDirs = uniqueSorted(
    paths
      .map((path) => path.split('/')[0])
      .filter((segment) => segment && !segment.includes('.'))
  )
  const boundaryPaths = topLevelDirs.slice(0, MAX_ENTRY_PATHS)
  if (boundaryPaths.length < 2) return []
  return [
    entry(
      'architectural-boundary-top-level',
      'architectural_boundary',
      'Top-level directories define coarse ownership boundaries',
      boundaryPaths,
      updatedAt,
      'Keep changes inside the smallest relevant ownership boundary unless the task proves a cross-boundary need.'
    )
  ]
}

function doNotRepeatEntries(updatedAt: string): RepoConventionIndexEntry[] {
  return [
    entry(
      'do-not-repeat-placeholder-completion',
      'do_not_repeat',
      'Do not treat placeholder files or stub UI as completion evidence',
      [],
      updatedAt,
      'Completion claims need Evidence Pack refs to tests, fixtures, screenshots, or inspected implementation.'
    ),
    entry(
      'do-not-repeat-parallel-abstractions',
      'do_not_repeat',
      'Do not add parallel abstractions when an existing local pattern fits',
      [],
      updatedAt,
      'Search for existing helpers/components before adding a new framework, adapter layer, or style island.'
    )
  ]
}

export function buildRepoConventionIndexSnapshot(
  input: BuildRepoConventionIndexInput
): RepoConventionIndexSnapshot {
  const workspaceId = input.workspaceId.trim()
  if (!workspaceId) throw new Error('Repo convention index requires a workspace id.')
  const updatedAt = (input.now || new Date()).toISOString()
  const paths = uniqueSorted(
    input.files.map((item) =>
      typeof item === 'string' ? item : item.kind === 'directory' ? item.path : item.path
    )
  )
  const entries = [
    ...detectPackageManagers(paths, updatedAt),
    ...detectFrameworks(paths, updatedAt),
    ...detectTests(paths, updatedAt),
    ...detectStyleSystems(paths, updatedAt),
    ...detectGeneratedPaths(paths, updatedAt),
    ...detectArchitecturalBoundaries(paths, updatedAt),
    ...doNotRepeatEntries(updatedAt)
  ]
  return {
    schemaVersion: 1,
    workspaceId,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    generatedAt: updatedAt,
    entries
  }
}

export function summarizeRepoConventionIndexScan(
  snapshot: RepoConventionIndexSnapshot,
  input: { fileCount: number; truncated?: boolean }
): RepoConventionScanSummary {
  return {
    fileCount: input.fileCount,
    entryCount: snapshot.entries.length,
    truncated: input.truncated === true
  }
}
