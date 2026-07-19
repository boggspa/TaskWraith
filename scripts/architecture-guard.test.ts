import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const ts = require('typescript') as typeof import('typescript')
type ArchitectureBaseline = {
  schemaVersion: number
  rendererMainRuntimeEdges: Array<{ from: string; to: string }>
  mainRendererRuntimeEdges: Array<{ from: string; to: string }>
  mainComputedRuntimeLoadAllowances: Array<{
    from: string
    kind: string
    expression: string
  }>
  sharedUpwardRuntimeEdges: Array<{ from: string; to: string }>
  hotspotBudgets: Record<string, { maxLines: number; maxBranchPoints: number }>
}
const {
  baselineMonotonicityFailures,
  collectMainRendererRuntimeSurface,
  collectRendererMainRuntimeEdges,
  collectSharedUpwardRuntimeEdges,
  evaluateArchitecture,
  measureSource,
  physicalLineCount,
  runtimeModuleSurface,
  runtimeModuleSpecifiers,
  validateBaseline
}: {
  baselineMonotonicityFailures: (
    previous: ArchitectureBaseline,
    current: ArchitectureBaseline,
    options?: { currentSourcePaths?: Set<string> }
  ) => string[]
  collectMainRendererRuntimeSurface: (options: {
    repoRoot: string
    mainRoot: string
    rendererRoot: string
    compilerOptions: Record<string, unknown>
  }) => {
    edges: Array<{ from: string; to: string }>
    unsafeLoads: Array<{ from: string; kind: string; expression: string }>
  }
  collectRendererMainRuntimeEdges: (options: {
    repoRoot: string
    rendererRoot: string
    mainRoot: string
    compilerOptions: Record<string, unknown>
  }) => Array<{ from: string; to: string }>
  collectSharedUpwardRuntimeEdges: (options: {
    repoRoot: string
    sharedRoot: string
    targetRoots: string[]
    compilerOptions: Record<string, unknown>
  }) => Array<{ from: string; to: string }>
  evaluateArchitecture: (input: {
    baseline: {
      schemaVersion: number
      rendererMainRuntimeEdges: Array<{ from: string; to: string }>
      hotspotBudgets: Record<string, { maxLines: number; maxBranchPoints: number }>
    }
    currentEdges: Array<{ from: string; to: string }>
    currentMainRendererEdges: Array<{ from: string; to: string }>
    currentMainComputedRuntimeLoads: Array<{ from: string; kind: string; expression: string }>
    currentSharedUpwardEdges: Array<{ from: string; to: string }>
    hotspotMeasurements: Record<string, { lines: number; branchPoints: number }>
  }) => {
    failures: string[]
    newEdges: string[]
    removedEdges: string[]
    newMainRendererEdges: string[]
    removedMainRendererEdges: string[]
    newMainComputedRuntimeLoads: string[]
    removedMainComputedRuntimeLoads: string[]
    newSharedUpwardEdges: string[]
    removedSharedUpwardEdges: string[]
  }
  measureSource: (source: string, filePath?: string) => { lines: number; branchPoints: number }
  physicalLineCount: (source: string) => number
  runtimeModuleSpecifiers: (source: string, filePath?: string) => string[]
  runtimeModuleSurface: (
    source: string,
    filePath?: string,
    compilerOptions?: Record<string, unknown>
  ) => {
    specifiers: string[]
    globPatterns: string[]
    unsafeLoads: Array<{ kind: string; expression: string }>
  }
  validateBaseline: (baseline: unknown) => void
} = require('./architecture-guard.cjs')

const baseline: ArchitectureBaseline = {
  schemaVersion: 1,
  rendererMainRuntimeEdges: [{ from: 'src/renderer/src/legacy.ts', to: 'src/main/LegacyHelper' }],
  mainRendererRuntimeEdges: [{ from: 'src/main/legacy.ts', to: 'src/renderer/src/LegacyView' }],
  mainComputedRuntimeLoadAllowances: [
    {
      from: 'src/main/optional.ts',
      kind: 'indirect Function runtime loader',
      expression: "new Function('specifier', 'return import(specifier)')"
    }
  ],
  sharedUpwardRuntimeEdges: [],
  hotspotBudgets: {
    'src/main/index.ts': { maxLines: 10, maxBranchPoints: 2 }
  }
}

describe('architecture guard import classification', () => {
  it('allows erased type-only imports and exports', () => {
    const source = [
      "import type { A } from '../../main/a'",
      "import { type B } from '../../main/b'",
      "export type { C } from '../../main/c'",
      "export { type D } from '../../main/d'",
      "import { E } from '../../main/e'",
      'const value: E | null = null',
      'void value'
    ].join('\n')

    expect(runtimeModuleSpecifiers(source)).toEqual([])
  })

  it('finds static, mixed, side-effect, dynamic, require, and re-export dependencies', () => {
    const source = [
      "import value, { type A } from '../../main/static'",
      'void value',
      "import '../../main/side-effect'",
      "export { value } from '../../main/re-export'",
      "void import('../../main/dynamic', { with: { type: 'json' } })",
      "require('../../main/required')"
    ].join('\n')

    expect(runtimeModuleSpecifiers(source)).toEqual([
      '../../main/static',
      '../../main/side-effect',
      '../../main/re-export',
      '../../main/dynamic',
      '../../main/required'
    ])
  })

  it('recognizes literal Vite glob patterns as runtime module dependencies', () => {
    const source = [
      "import.meta.glob('../../main/features/*.ts')",
      "import.meta.glob(['../../main/a/*.ts', '!../../main/a/ignored.ts'])"
    ].join('\n')

    expect(runtimeModuleSpecifiers(source)).toEqual([
      '../../main/features/*.ts',
      '../../main/a/*.ts'
    ])
  })

  it('classifies computed dynamic loaders as unauditable', () => {
    const source = [
      "const target = '../../main/runtime'",
      'void import(target)',
      'require(target)',
      'import.meta.glob([target])',
      "new Function('specifier', 'return import(specifier)')"
    ].join('\n')

    expect(
      runtimeModuleSurface(source, 'source.ts', {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022
      }).unsafeLoads.map((load) => load.kind)
    ).toEqual([
      'computed import()',
      'computed require()',
      'computed import.meta.glob()',
      'indirect Function runtime loader'
    ])
  })

  it('collects only emitted production renderer -> main edges', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'taskwraith-architecture-guard-'))
    const rendererRoot = path.join(repoRoot, 'src/renderer/src')
    const mainRoot = path.join(repoRoot, 'src/main')
    try {
      mkdirSync(rendererRoot, { recursive: true })
      mkdirSync(mainRoot, { recursive: true })
      writeFileSync(path.join(mainRoot, 'Helper.ts'), 'export const helper = 1\n')
      writeFileSync(
        path.join(rendererRoot, 'runtime.ts'),
        "import { helper } from '../../main/Helper'\nvoid helper\n"
      )
      writeFileSync(
        path.join(rendererRoot, 'types.ts'),
        "import { helper } from '../../main/Helper'\ntype Helper = typeof helper\n"
      )
      writeFileSync(
        path.join(rendererRoot, 'runtime.test.ts'),
        "import { helper } from '../../main/Helper'\nvoid helper\n"
      )

      expect(
        collectRendererMainRuntimeEdges({
          repoRoot,
          rendererRoot,
          mainRoot,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            target: ts.ScriptTarget.ES2022
          }
        })
      ).toEqual([
        {
          from: 'src/renderer/src/runtime.ts',
          to: 'src/main/Helper'
        }
      ])
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })

  it('collects literal Vite glob edges into main', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'taskwraith-architecture-glob-'))
    const rendererRoot = path.join(repoRoot, 'src/renderer/src')
    const mainRoot = path.join(repoRoot, 'src/main')
    try {
      mkdirSync(rendererRoot, { recursive: true })
      mkdirSync(mainRoot, { recursive: true })
      writeFileSync(
        path.join(rendererRoot, 'runtime.ts'),
        "export const modules = import.meta.glob(['../../main/features/*.ts', '/src/main/root/*.ts', '../../{main,shared}/**/*.ts'])\n"
      )

      expect(
        collectRendererMainRuntimeEdges({
          repoRoot,
          rendererRoot,
          mainRoot,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            target: ts.ScriptTarget.ES2022
          }
        })
      ).toEqual([
        {
          from: 'src/renderer/src/runtime.ts',
          to: 'src/main/<wide-glob>'
        },
        {
          from: 'src/renderer/src/runtime.ts',
          to: 'src/main/features/*'
        },
        {
          from: 'src/renderer/src/runtime.ts',
          to: 'src/main/root/*'
        }
      ])
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })

  it('rejects computed runtime loaders in production renderer code', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'taskwraith-architecture-computed-'))
    const rendererRoot = path.join(repoRoot, 'src/renderer/src')
    const mainRoot = path.join(repoRoot, 'src/main')
    try {
      mkdirSync(rendererRoot, { recursive: true })
      mkdirSync(mainRoot, { recursive: true })
      writeFileSync(
        path.join(rendererRoot, 'runtime.ts'),
        "const target = '../../main/Helper'\nvoid import(target)\n"
      )

      expect(() =>
        collectRendererMainRuntimeEdges({
          repoRoot,
          rendererRoot,
          mainRoot,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            target: ts.ScriptTarget.ES2022
          }
        })
      ).toThrow(/non-literal runtime module load/)
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })

  it('collects main -> renderer edges and audits main computed loaders', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'taskwraith-main-renderer-'))
    const mainRoot = path.join(repoRoot, 'src/main')
    const rendererRoot = path.join(repoRoot, 'src/renderer')
    try {
      mkdirSync(mainRoot, { recursive: true })
      mkdirSync(path.join(rendererRoot, 'src'), { recursive: true })
      writeFileSync(path.join(rendererRoot, 'src/View.ts'), 'export const view = 1\n')
      writeFileSync(
        path.join(mainRoot, 'runtime.ts'),
        [
          "import { view } from '../renderer/src/View'",
          'void view',
          "const target = '../renderer/src/Other'",
          'void import(target)'
        ].join('\n')
      )

      expect(
        collectMainRendererRuntimeSurface({
          repoRoot,
          mainRoot,
          rendererRoot,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            target: ts.ScriptTarget.ES2022
          }
        })
      ).toEqual({
        edges: [{ from: 'src/main/runtime.ts', to: 'src/renderer/src/View' }],
        unsafeLoads: [
          {
            from: 'src/main/runtime.ts',
            kind: 'computed import()',
            expression: 'import(target)'
          }
        ]
      })
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })

  it('rejects runtime edges from shared back up into main or renderer', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'taskwraith-shared-architecture-guard-'))
    const sharedRoot = path.join(repoRoot, 'src/shared')
    const mainRoot = path.join(repoRoot, 'src/main')
    const rendererRoot = path.join(repoRoot, 'src/renderer')
    try {
      mkdirSync(sharedRoot, { recursive: true })
      mkdirSync(mainRoot, { recursive: true })
      mkdirSync(rendererRoot, { recursive: true })
      writeFileSync(path.join(mainRoot, 'MainHelper.ts'), 'export const helper = 1\n')
      writeFileSync(path.join(rendererRoot, 'RendererType.ts'), 'export interface View {}\n')
      writeFileSync(
        path.join(sharedRoot, 'upward.ts'),
        "import { helper } from '../main/MainHelper'\nvoid helper\n"
      )
      writeFileSync(
        path.join(sharedRoot, 'type-only.ts'),
        "import type { View } from '../renderer/RendererType'\nexport type SharedView = View\n"
      )

      expect(
        collectSharedUpwardRuntimeEdges({
          repoRoot,
          sharedRoot,
          targetRoots: [mainRoot, rendererRoot],
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            target: ts.ScriptTarget.ES2022
          }
        })
      ).toEqual([
        {
          from: 'src/shared/upward.ts',
          to: 'src/main/MainHelper'
        }
      ])
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })

  it('rejects computed runtime loaders in shared code too', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'taskwraith-shared-computed-'))
    const sharedRoot = path.join(repoRoot, 'src/shared')
    const mainRoot = path.join(repoRoot, 'src/main')
    const rendererRoot = path.join(repoRoot, 'src/renderer')
    try {
      mkdirSync(sharedRoot, { recursive: true })
      mkdirSync(mainRoot, { recursive: true })
      mkdirSync(rendererRoot, { recursive: true })
      writeFileSync(
        path.join(sharedRoot, 'runtime.ts'),
        "const target = '../main/Helper'\nexport const helper = require(target)\n"
      )

      expect(() =>
        collectSharedUpwardRuntimeEdges({
          repoRoot,
          sharedRoot,
          targetRoots: [mainRoot, rendererRoot],
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            target: ts.ScriptTarget.ES2022
          }
        })
      ).toThrow(/non-literal runtime module load/)
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })
})

describe('architecture guard budgets', () => {
  it('counts physical lines without inventing a trailing blank line', () => {
    expect(physicalLineCount('')).toBe(0)
    expect(physicalLineCount('one')).toBe(1)
    expect(physicalLineCount('one\ntwo\n')).toBe(2)
    expect(physicalLineCount('one\r\ntwo')).toBe(2)
  })

  it('counts the documented branch-point forms deterministically', () => {
    const source = [
      'function choose(a: boolean, b: boolean) {',
      '  if (a && b) return a ? 1 : 2',
      '  for (let i = 0; i < 1; i += 1) {}',
      '  return a ?? b',
      '}'
    ].join('\n')

    expect(measureSource(source)).toEqual({ lines: 5, branchPoints: 5 })
  })

  it('fails only new dependency edges and hotspot growth', () => {
    validateBaseline(baseline)
    const result = evaluateArchitecture({
      baseline,
      currentEdges: [
        ...baseline.rendererMainRuntimeEdges,
        { from: 'src/renderer/src/new.ts', to: 'src/main/NewHelper' }
      ],
      currentMainRendererEdges: baseline.mainRendererRuntimeEdges,
      currentMainComputedRuntimeLoads: baseline.mainComputedRuntimeLoadAllowances,
      currentSharedUpwardEdges: [{ from: 'src/shared/upward.ts', to: 'src/main/NewHelper' }],
      hotspotMeasurements: {
        'src/main/index.ts': { lines: 11, branchPoints: 3 }
      }
    })

    expect(result.newEdges).toEqual(['src/renderer/src/new.ts -> src/main/NewHelper'])
    expect(result.newSharedUpwardEdges).toEqual(['src/shared/upward.ts -> src/main/NewHelper'])
    expect(result.failures).toHaveLength(4)
  })

  it('requires obsolete dependency allowances to be removed immediately', () => {
    const result = evaluateArchitecture({
      baseline,
      currentEdges: [],
      currentMainRendererEdges: baseline.mainRendererRuntimeEdges,
      currentMainComputedRuntimeLoads: baseline.mainComputedRuntimeLoadAllowances,
      currentSharedUpwardEdges: [],
      hotspotMeasurements: {
        'src/main/index.ts': { lines: 8, branchPoints: 1 }
      }
    })

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('Obsolete runtime edge allowance')
    expect(result.removedEdges).toEqual(['src/renderer/src/legacy.ts -> src/main/LegacyHelper'])
  })

  it('mechanically rejects baseline increases and removed hotspot ratchets', () => {
    const weakened = {
      ...baseline,
      rendererMainRuntimeEdges: [
        ...baseline.rendererMainRuntimeEdges,
        { from: 'src/renderer/src/new.ts', to: 'src/main/NewHelper' }
      ],
      mainRendererRuntimeEdges: [
        ...baseline.mainRendererRuntimeEdges,
        { from: 'src/main/new.ts', to: 'src/renderer/src/NewView' }
      ],
      mainComputedRuntimeLoadAllowances: [
        ...baseline.mainComputedRuntimeLoadAllowances,
        {
          from: 'src/main/new.ts',
          kind: 'computed import()',
          expression: 'import(target)'
        }
      ],
      hotspotBudgets: {
        'src/main/index.ts': { maxLines: 11, maxBranchPoints: 3 }
      }
    }
    expect(baselineMonotonicityFailures(baseline, weakened)).toEqual([
      'Renderer -> main runtime allowances were added:\n    src/renderer/src/new.ts -> src/main/NewHelper',
      'Main -> renderer runtime allowances were added:\n    src/main/new.ts -> src/renderer/src/NewView',
      'Main computed runtime-load allowances were added:\n    src/main/new.ts :: computed import(): import(target)',
      'src/main/index.ts maxLines increased from 10 to 11.',
      'src/main/index.ts maxBranchPoints increased from 2 to 3.'
    ])

    expect(
      baselineMonotonicityFailures(baseline, {
        ...baseline,
        hotspotBudgets: {}
      })
    ).toEqual(['Hotspot budget was removed while its source still exists: src/main/index.ts'])
  })

  it('retires a hotspot budget only after the guarded source is gone', () => {
    const retired = {
      ...baseline,
      hotspotBudgets: {}
    }

    expect(
      baselineMonotonicityFailures(baseline, retired, {
        currentSourcePaths: new Set(['src/main/index.ts'])
      })
    ).toEqual(['Hotspot budget was removed while its source still exists: src/main/index.ts'])

    expect(
      baselineMonotonicityFailures(baseline, retired, {
        currentSourcePaths: new Set()
      })
    ).toEqual([])
  })

  it('allows only monotonic baseline tightening', () => {
    expect(
      baselineMonotonicityFailures(baseline, {
        ...baseline,
        rendererMainRuntimeEdges: [],
        hotspotBudgets: {
          'src/main/index.ts': { maxLines: 9, maxBranchPoints: 1 },
          'src/renderer/src/App.tsx': { maxLines: 100, maxBranchPoints: 20 }
        }
      })
    ).toEqual([])
  })
})
