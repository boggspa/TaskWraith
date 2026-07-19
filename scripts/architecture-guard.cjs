#!/usr/bin/env node

/**
 * Grandfathered architecture ratchets.
 *
 * This guard deliberately does not require the current renderer/main boundary
 * debt or the three composition-root hotspots to be fixed in one change. It
 * records today's state and rejects only growth:
 *
 *   1. Production renderer code may keep the runtime imports from src/main
 *      listed in architecture-guard-baseline.json, but may not add another
 *      importer -> resolved-module edge. Type-only imports are erased and do
 *      not count. New cross-process contracts and pure helpers belong in
 *      src/shared.
 *   2. Main may keep its named runtime edge into renderer, but may not add
 *      another. Main's two indirect optional-SDK loaders are pinned exactly;
 *      new or changed computed loaders fail the same ratchet.
 *   3. src/shared may not acquire a runtime import/re-export from src/main or
 *      src/renderer. This keeps the intended lower layer from becoming a
 *      transitive escape hatch around the renderer/main boundary.
 *      Computed import()/require() calls are rejected in both source trees,
 *      and literal Vite import.meta.glob patterns participate in the same
 *      edge check, so runtime loaders cannot bypass the static-import scan.
 *   4. The three named hotspots may not grow beyond their physical-line or
 *      AST branch-point budgets. A branch point is an if/conditional, loop,
 *      catch, non-default switch case, or &&/||/?? expression. This is a
 *      deterministic growth signal, not a claim of full cyclomatic analysis.
 *
 * When an existing edge is removed or a hotspot shrinks, lower the baseline in
 * the same change to make the improvement durable. Never raise a baseline as
 * routine cleanup; an increase should receive explicit architecture review.
 * Type-only renderer -> main ownership debt is intentionally not counted by
 * this runtime guard; freezing that broader contract surface is a Horizon-2
 * follow-up rather than a guarantee of this script.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')

const REPO_ROOT = path.join(__dirname, '..')
const BASELINE_PATH = path.join(__dirname, 'architecture-guard-baseline.json')
const BASELINE_REPO_PATH = 'scripts/architecture-guard-baseline.json'
const WEB_TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.web.json')
const NODE_TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.node.json')

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/
const TEST_SOURCE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/
const MODULE_SOURCE_EXTENSION = /\.(?:d\.)?[cm]?[jt]sx?$/

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Unable to read ${toPosix(path.relative(REPO_ROOT, filePath))}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function githubEventComparisonRef() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return null
  let event
  try {
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Unable to read GitHub event payload for architecture baseline comparison: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const eventName = process.env.GITHUB_EVENT_NAME
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    return typeof event.pull_request?.base?.sha === 'string' ? event.pull_request.base.sha : null
  }
  if (eventName === 'merge_group') {
    return typeof event.merge_group?.base_sha === 'string' ? event.merge_group.base_sha : null
  }
  if (eventName === 'push') {
    const before = typeof event.before === 'string' ? event.before : ''
    return before && !/^0+$/.test(before) ? before : null
  }
  return null
}

function baselineComparisonRef() {
  const explicit = process.env.ARCHITECTURE_GUARD_BASELINE_REF?.trim()
  if (explicit) return explicit
  const eventRef = githubEventComparisonRef()
  if (eventRef) return eventRef
  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim()
  if (githubBaseRef) return `origin/${githubBaseRef}`
  // Local runs compare the working-tree baseline with the checked-out version.
  // On the first landing HEAD has no baseline, which is the one bootstrap case.
  return 'HEAD'
}

function readBaselineAtRef(ref) {
  try {
    gitOutput(['cat-file', '-e', `${ref}^{commit}`])
  } catch {
    throw new Error(
      `Cannot resolve architecture baseline comparison ref ${JSON.stringify(ref)}. CI must check out full history (fetch-depth: 0).`
    )
  }
  const matchingPaths = gitOutput(['ls-tree', '-r', '--name-only', ref, '--', BASELINE_REPO_PATH])
  if (!matchingPaths) return null
  try {
    return JSON.parse(gitOutput(['show', `${ref}:${BASELINE_REPO_PATH}`]))
  } catch (error) {
    throw new Error(
      `Unable to read architecture baseline from ${ref}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function readCompilerOptions(configPath = WEB_TSCONFIG_PATH) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('\n')
    )
  }
  return parsed.options
}

function scriptKindFor(filePath) {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX
  if (/\.(?:cjs|mjs|js)$/i.test(filePath)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function parseSource(filePath, source) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath)
  )
  const diagnostics = sourceFile.parseDiagnostics || []
  if (diagnostics.length > 0) {
    throw new Error(
      `${filePath}: ${diagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('; ')}`
    )
  }
  return sourceFile
}

function isTypeOnlyImport(node) {
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  return Boolean(
    clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  )
}

function isTypeOnlyExport(node) {
  if (node.isTypeOnly) return true
  return Boolean(
    node.exportClause &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  )
}

function importMetaGlobMethod(expression) {
  if (!ts.isPropertyAccessExpression(expression)) return null
  if (expression.name.text !== 'glob' && expression.name.text !== 'globEager') return null
  const owner = expression.expression
  if (
    !ts.isMetaProperty(owner) ||
    owner.keywordToken !== ts.SyntaxKind.ImportKeyword ||
    owner.name.text !== 'meta'
  ) {
    return null
  }
  return expression.name.text
}

function literalGlobPatterns(argument) {
  if (ts.isStringLiteralLike(argument)) return [argument.text]
  if (!ts.isArrayLiteralExpression(argument)) return null
  const patterns = []
  for (const element of argument.elements) {
    if (!ts.isStringLiteralLike(element)) return null
    patterns.push(element.text)
  }
  return patterns
}

function functionConstructorLoadsModule(node) {
  const expression = node.expression
  if (!ts.isIdentifier(expression) || expression.text !== 'Function') return false
  return (node.arguments || []).some(
    (argument) =>
      ts.isStringLiteralLike(argument) && /\b(?:import|require)\s*\(/.test(argument.text)
  )
}

function runtimeSyntaxModuleSurface(source, filePath) {
  const sourceFile = parseSource(filePath, source)
  const specifiers = []
  const globPatterns = []
  const unsafeLoads = []

  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !isTypeOnlyImport(node)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !isTypeOnlyExport(node)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isNewExpression(node) && functionConstructorLoadsModule(node)) {
      unsafeLoads.push({
        kind: 'indirect Function runtime loader',
        expression: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 180)
      })
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (dynamicImport || commonJsRequire) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument)) {
          specifiers.push(argument.text)
        } else {
          unsafeLoads.push({
            kind: dynamicImport ? 'computed import()' : 'computed require()',
            expression: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 180)
          })
        }
      } else {
        const globMethod = importMetaGlobMethod(node.expression)
        if (globMethod) {
          const argument = node.arguments[0]
          const patterns = argument ? literalGlobPatterns(argument) : null
          if (!patterns) {
            unsafeLoads.push({
              kind: `computed import.meta.${globMethod}()`,
              expression: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 180)
            })
          } else {
            // Negative Vite patterns subtract matches and do not load modules.
            const positivePatterns = patterns.filter((pattern) => !pattern.startsWith('!'))
            specifiers.push(...positivePatterns)
            globPatterns.push(...positivePatterns)
          }
        } else if (functionConstructorLoadsModule(node)) {
          unsafeLoads.push({
            kind: 'indirect Function runtime loader',
            expression: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 180)
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { specifiers, globPatterns, unsafeLoads }
}

function runtimeModuleSurface(source, filePath = 'source.ts', compilerOptions = {}) {
  // A syntactically value-shaped import can still be erased when every binding
  // is used only as a type. Scan TypeScript's emitted module surface so this
  // guard measures the same runtime dependency direction as the renderer build
  // (rather than forcing unrelated import-type cleanup into the baseline).
  parseSource(filePath, source)
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      ...compilerOptions,
      declaration: false,
      declarationMap: false,
      emitDeclarationOnly: false,
      inlineSourceMap: false,
      noEmit: false,
      sourceMap: false
    },
    fileName: filePath,
    reportDiagnostics: true
  })
  const errors = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  )
  if (errors.length > 0) {
    throw new Error(
      `${filePath}: ${errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('; ')}`
    )
  }
  const emittedPath = filePath.replace(SOURCE_EXTENSION, '.js')
  return runtimeSyntaxModuleSurface(transpiled.outputText, emittedPath)
}

function runtimeModuleSpecifiers(source, filePath = 'source.ts', compilerOptions = {}) {
  return runtimeModuleSurface(source, filePath, compilerOptions).specifiers
}

function walkProductionSources(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(fullPath)
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSION.test(entry.name) &&
        !TEST_SOURCE.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(fullPath)
      }
    }
  }
  return files.sort()
}

function normalizeModuleTarget(repoRoot, target) {
  return toPosix(path.relative(repoRoot, target)).replace(MODULE_SOURCE_EXTENSION, '')
}

function resolveModuleTarget({ compilerOptions, importer, repoRoot, specifier, targetRoots }) {
  const resolution = ts.resolveModuleName(
    specifier,
    importer,
    compilerOptions,
    ts.sys
  ).resolvedModule
  let target = resolution?.resolvedFileName

  // Keep the boundary fail-closed even when a new relative import points at a
  // not-yet-created or currently-unresolvable src/main module. Typecheck will
  // report the missing module separately; the architecture intent still
  // matters here.
  if (!target && specifier.startsWith('.')) {
    target = path.resolve(path.dirname(importer), specifier)
  }
  if (!target || !targetRoots.some((targetRoot) => isWithin(targetRoot, target))) return null
  return normalizeModuleTarget(repoRoot, target)
}

function resolveGlobTargets({ importer, repoRoot, pattern, targetRoots }) {
  const absolutePattern = pattern.startsWith('/')
    ? path.resolve(repoRoot, pattern.slice(1))
    : pattern.startsWith('.')
      ? path.resolve(path.dirname(importer), pattern)
      : null
  if (!absolutePattern) return []
  const magicIndex = [...absolutePattern].findIndex((character) =>
    ['*', '?', '{', '[', '('].includes(character)
  )
  const staticPrefix = magicIndex < 0 ? absolutePattern : absolutePattern.slice(0, magicIndex)
  const globRoot = /[\\/]$/.test(staticPrefix) ? staticPrefix : path.dirname(staticPrefix)
  const targets = []
  for (const targetRoot of targetRoots) {
    if (isWithin(targetRoot, absolutePattern)) {
      targets.push(normalizeModuleTarget(repoRoot, absolutePattern))
    } else if (isWithin(globRoot, targetRoot)) {
      // A brace/extglob rooted above a protected tree can select it even when
      // the literal pattern does not begin with that tree's name.
      targets.push(`${normalizeModuleTarget(repoRoot, targetRoot)}/<wide-glob>`)
    }
  }
  return [...new Set(targets)]
}

function collectRuntimeDependencySurface({ compilerOptions, repoRoot, sourceRoot, targetRoots }) {
  const edges = new Map()
  const unsafeLoads = new Map()

  for (const importer of walkProductionSources(sourceRoot)) {
    const source = fs.readFileSync(importer, 'utf8')
    const from = toPosix(path.relative(repoRoot, importer))
    const surface = runtimeModuleSurface(source, importer, compilerOptions)
    for (const load of surface.unsafeLoads) {
      const key = `${from} :: ${load.kind}: ${load.expression}`
      unsafeLoads.set(key, { from, ...load })
    }
    const globPatterns = new Set(surface.globPatterns)
    for (const specifier of surface.specifiers) {
      const targets = globPatterns.has(specifier)
        ? resolveGlobTargets({ importer, repoRoot, pattern: specifier, targetRoots })
        : [
            resolveModuleTarget({
              compilerOptions,
              importer,
              repoRoot,
              specifier,
              targetRoots
            })
          ].filter(Boolean)
      for (const to of targets) {
        const key = `${from} -> ${to}`
        edges.set(key, { from, to })
      }
    }
  }

  return {
    edges: [...edges.values()].sort((left, right) =>
      `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`)
    ),
    unsafeLoads: [...unsafeLoads.values()].sort((left, right) =>
      `${left.from}\0${left.kind}\0${left.expression}`.localeCompare(
        `${right.from}\0${right.kind}\0${right.expression}`
      )
    )
  }
}

function rejectUnsafeRuntimeLoads(surface) {
  if (surface.unsafeLoads.length === 0) return surface.edges
  const details = surface.unsafeLoads
    .map((load) => `${load.from} (${load.kind}: ${load.expression})`)
    .join('; ')
  throw new Error(
    `A non-literal runtime module load${surface.unsafeLoads.length === 1 ? ' was' : 's were'} found (${details}). Use literal import/require/glob patterns so dependency direction remains auditable.`
  )
}

function collectRuntimeEdges(options) {
  return rejectUnsafeRuntimeLoads(collectRuntimeDependencySurface(options))
}

function collectRendererMainRuntimeEdges(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT
  return collectRuntimeEdges({
    repoRoot,
    sourceRoot: options.rendererRoot || path.join(repoRoot, 'src/renderer/src'),
    targetRoots: [options.mainRoot || path.join(repoRoot, 'src/main')],
    compilerOptions: options.compilerOptions || readCompilerOptions()
  })
}

function collectSharedUpwardRuntimeEdges(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT
  return collectRuntimeEdges({
    repoRoot,
    sourceRoot: options.sharedRoot || path.join(repoRoot, 'src/shared'),
    targetRoots: options.targetRoots || [
      path.join(repoRoot, 'src/main'),
      path.join(repoRoot, 'src/renderer')
    ],
    compilerOptions: options.compilerOptions || readCompilerOptions()
  })
}

function collectMainRendererRuntimeSurface(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT
  return collectRuntimeDependencySurface({
    repoRoot,
    sourceRoot: options.mainRoot || path.join(repoRoot, 'src/main'),
    targetRoots: [options.rendererRoot || path.join(repoRoot, 'src/renderer')],
    compilerOptions: options.compilerOptions || readCompilerOptions(NODE_TSCONFIG_PATH)
  })
}

function physicalLineCount(source) {
  if (source.length === 0) return 0
  const separators = source.match(/\r\n|\r|\n/g)?.length || 0
  return separators + (/\r\n$|\r$|\n$/.test(source) ? 0 : 1)
}

function isBranchPoint(node) {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isCaseClause(node)
  ) {
    return true
  }
  return Boolean(
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken
    ].includes(node.operatorToken.kind)
  )
}

function measureSource(source, filePath = 'source.ts') {
  const sourceFile = parseSource(filePath, source)
  let branchPoints = 0

  function visit(node) {
    if (isBranchPoint(node)) branchPoints += 1
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { lines: physicalLineCount(source), branchPoints }
}

function validateBaseline(baseline) {
  if (!baseline || baseline.schemaVersion !== 1) {
    throw new Error('architecture baseline must have schemaVersion: 1')
  }
  if (!Array.isArray(baseline.rendererMainRuntimeEdges)) {
    throw new Error('architecture baseline must list rendererMainRuntimeEdges')
  }
  if (!Array.isArray(baseline.mainRendererRuntimeEdges)) {
    throw new Error('architecture baseline must list mainRendererRuntimeEdges')
  }
  if (!Array.isArray(baseline.mainComputedRuntimeLoadAllowances)) {
    throw new Error('architecture baseline must list mainComputedRuntimeLoadAllowances')
  }
  if (!Array.isArray(baseline.sharedUpwardRuntimeEdges)) {
    throw new Error('architecture baseline must list sharedUpwardRuntimeEdges')
  }
  if (!baseline.hotspotBudgets || typeof baseline.hotspotBudgets !== 'object') {
    throw new Error('architecture baseline must define hotspotBudgets')
  }

  const seen = new Set()
  for (const edge of baseline.rendererMainRuntimeEdges) {
    if (
      !edge ||
      typeof edge.from !== 'string' ||
      !edge.from.startsWith('src/renderer/') ||
      typeof edge.to !== 'string' ||
      !edge.to.startsWith('src/main/')
    ) {
      throw new Error(`Invalid renderer/main baseline edge: ${JSON.stringify(edge)}`)
    }
    const key = `${edge.from} -> ${edge.to}`
    if (seen.has(key)) throw new Error(`Duplicate renderer/main baseline edge: ${key}`)
    seen.add(key)
  }

  for (const edge of baseline.sharedUpwardRuntimeEdges) {
    if (
      !edge ||
      typeof edge.from !== 'string' ||
      !edge.from.startsWith('src/shared/') ||
      typeof edge.to !== 'string' ||
      (!edge.to.startsWith('src/main/') && !edge.to.startsWith('src/renderer/'))
    ) {
      throw new Error(`Invalid shared upward baseline edge: ${JSON.stringify(edge)}`)
    }
    const key = `${edge.from} -> ${edge.to}`
    if (seen.has(key)) throw new Error(`Duplicate architecture baseline edge: ${key}`)
    seen.add(key)
  }

  for (const edge of baseline.mainRendererRuntimeEdges) {
    if (
      !edge ||
      typeof edge.from !== 'string' ||
      !edge.from.startsWith('src/main/') ||
      typeof edge.to !== 'string' ||
      !edge.to.startsWith('src/renderer/')
    ) {
      throw new Error(`Invalid main/renderer baseline edge: ${JSON.stringify(edge)}`)
    }
    const key = `${edge.from} -> ${edge.to}`
    if (seen.has(key)) throw new Error(`Duplicate architecture baseline edge: ${key}`)
    seen.add(key)
  }

  for (const load of baseline.mainComputedRuntimeLoadAllowances) {
    if (
      !load ||
      typeof load.from !== 'string' ||
      !load.from.startsWith('src/main/') ||
      typeof load.kind !== 'string' ||
      !load.kind ||
      typeof load.expression !== 'string' ||
      !load.expression
    ) {
      throw new Error(`Invalid main computed-load allowance: ${JSON.stringify(load)}`)
    }
    const key = `${load.from} :: ${load.kind}: ${load.expression}`
    if (seen.has(key)) throw new Error(`Duplicate architecture baseline allowance: ${key}`)
    seen.add(key)
  }

  for (const [filePath, budget] of Object.entries(baseline.hotspotBudgets)) {
    if (
      !filePath.startsWith('src/') ||
      !budget ||
      !Number.isInteger(budget.maxLines) ||
      budget.maxLines < 0 ||
      !Number.isInteger(budget.maxBranchPoints) ||
      budget.maxBranchPoints < 0
    ) {
      throw new Error(`Invalid hotspot budget for ${filePath}`)
    }
  }
}

function edgeDiff(allowedEdges, currentEdges) {
  const allowedKeys = new Set(allowedEdges.map((edge) => `${edge.from} -> ${edge.to}`))
  const currentKeys = new Set(currentEdges.map((edge) => `${edge.from} -> ${edge.to}`))
  return {
    added: [...currentKeys].filter((key) => !allowedKeys.has(key)).sort(),
    removed: [...allowedKeys].filter((key) => !currentKeys.has(key)).sort()
  }
}

function unsafeLoadDiff(allowedLoads, currentLoads) {
  const key = (load) => `${load.from} :: ${load.kind}: ${load.expression}`
  const allowedKeys = new Set(allowedLoads.map(key))
  const currentKeys = new Set(currentLoads.map(key))
  return {
    added: [...currentKeys].filter((value) => !allowedKeys.has(value)).sort(),
    removed: [...allowedKeys].filter((value) => !currentKeys.has(value)).sort()
  }
}

function baselineMonotonicityFailures(previous, current, options = {}) {
  validateBaseline(previous)
  validateBaseline(current)
  const currentSourcePaths = options.currentSourcePaths ?? null
  const failures = []
  const rendererAllowanceGrowth = edgeDiff(
    previous.rendererMainRuntimeEdges,
    current.rendererMainRuntimeEdges
  ).added
  const mainRendererAllowanceGrowth = edgeDiff(
    previous.mainRendererRuntimeEdges,
    current.mainRendererRuntimeEdges
  ).added
  const mainComputedAllowanceGrowth = unsafeLoadDiff(
    previous.mainComputedRuntimeLoadAllowances,
    current.mainComputedRuntimeLoadAllowances
  ).added
  const sharedAllowanceGrowth = edgeDiff(
    previous.sharedUpwardRuntimeEdges,
    current.sharedUpwardRuntimeEdges
  ).added
  if (rendererAllowanceGrowth.length > 0) {
    failures.push(
      `Renderer -> main runtime allowances were added:\n${rendererAllowanceGrowth.map((edge) => `    ${edge}`).join('\n')}`
    )
  }
  if (mainRendererAllowanceGrowth.length > 0) {
    failures.push(
      `Main -> renderer runtime allowances were added:\n${mainRendererAllowanceGrowth.map((edge) => `    ${edge}`).join('\n')}`
    )
  }
  if (mainComputedAllowanceGrowth.length > 0) {
    failures.push(
      `Main computed runtime-load allowances were added:\n${mainComputedAllowanceGrowth.map((load) => `    ${load}`).join('\n')}`
    )
  }
  if (sharedAllowanceGrowth.length > 0) {
    failures.push(
      `Shared upward runtime allowances were added:\n${sharedAllowanceGrowth.map((edge) => `    ${edge}`).join('\n')}`
    )
  }
  for (const [filePath, previousBudget] of Object.entries(previous.hotspotBudgets)) {
    const currentBudget = current.hotspotBudgets[filePath]
    if (!currentBudget) {
      // A budget can retire only when the guarded composition root itself has
      // been fully removed. Callers that do not supply a complete current-tree
      // path set stay fail-closed, as does a rename that leaves the old path in
      // place. This lets a successful strangler extraction delete its final
      // empty shell without making arbitrary budget deletion a bypass.
      if (!currentSourcePaths || currentSourcePaths.has(filePath)) {
        failures.push(`Hotspot budget was removed while its source still exists: ${filePath}`)
      }
      continue
    }
    if (currentBudget.maxLines > previousBudget.maxLines) {
      failures.push(
        `${filePath} maxLines increased from ${previousBudget.maxLines} to ${currentBudget.maxLines}.`
      )
    }
    if (currentBudget.maxBranchPoints > previousBudget.maxBranchPoints) {
      failures.push(
        `${filePath} maxBranchPoints increased from ${previousBudget.maxBranchPoints} to ${currentBudget.maxBranchPoints}.`
      )
    }
  }
  return failures
}

function evaluateArchitecture({
  baseline,
  currentEdges,
  currentMainRendererEdges,
  currentMainComputedRuntimeLoads,
  currentSharedUpwardEdges,
  hotspotMeasurements
}) {
  const failures = []
  const rendererMain = edgeDiff(baseline.rendererMainRuntimeEdges, currentEdges)
  const mainRenderer = edgeDiff(baseline.mainRendererRuntimeEdges, currentMainRendererEdges)
  const mainComputed = unsafeLoadDiff(
    baseline.mainComputedRuntimeLoadAllowances,
    currentMainComputedRuntimeLoads
  )
  const sharedUpward = edgeDiff(baseline.sharedUpwardRuntimeEdges, currentSharedUpwardEdges)
  const newEdges = rendererMain.added
  const removedEdges = rendererMain.removed

  if (newEdges.length > 0) {
    failures.push(
      `New renderer -> main runtime edge${newEdges.length === 1 ? '' : 's'}:\n${newEdges.map((edge) => `    ${edge}`).join('\n')}`
    )
  }
  if (mainRenderer.added.length > 0) {
    failures.push(
      `New main -> renderer runtime edge${mainRenderer.added.length === 1 ? '' : 's'}:\n${mainRenderer.added.map((edge) => `    ${edge}`).join('\n')}`
    )
  }
  if (mainComputed.added.length > 0) {
    failures.push(
      `New non-literal runtime module load${mainComputed.added.length === 1 ? '' : 's'} in main:\n${mainComputed.added.map((load) => `    ${load}`).join('\n')}`
    )
  }
  if (sharedUpward.added.length > 0) {
    failures.push(
      `New shared -> main/renderer runtime edge${sharedUpward.added.length === 1 ? '' : 's'}:\n${sharedUpward.added.map((edge) => `    ${edge}`).join('\n')}`
    )
  }
  const obsoleteAllowances = [
    ...removedEdges,
    ...mainRenderer.removed,
    ...mainComputed.removed,
    ...sharedUpward.removed
  ].sort()
  if (obsoleteAllowances.length > 0) {
    failures.push(
      `Obsolete runtime edge allowance${obsoleteAllowances.length === 1 ? '' : 's'} must be removed from the baseline:\n${obsoleteAllowances.map((edge) => `    ${edge}`).join('\n')}`
    )
  }

  for (const [filePath, budget] of Object.entries(baseline.hotspotBudgets)) {
    const measurement = hotspotMeasurements[filePath]
    if (!measurement) {
      failures.push(`Hotspot is missing or unmeasured: ${filePath}`)
      continue
    }
    if (measurement.lines > budget.maxLines) {
      failures.push(
        `${filePath} has ${measurement.lines} lines; budget is ${budget.maxLines} (+${measurement.lines - budget.maxLines}).`
      )
    }
    if (measurement.branchPoints > budget.maxBranchPoints) {
      failures.push(
        `${filePath} has ${measurement.branchPoints} branch points; budget is ${budget.maxBranchPoints} (+${measurement.branchPoints - budget.maxBranchPoints}).`
      )
    }
  }

  return {
    failures,
    newEdges,
    removedEdges,
    newMainRendererEdges: mainRenderer.added,
    removedMainRendererEdges: mainRenderer.removed,
    newMainComputedRuntimeLoads: mainComputed.added,
    removedMainComputedRuntimeLoads: mainComputed.removed,
    newSharedUpwardEdges: sharedUpward.added,
    removedSharedUpwardEdges: sharedUpward.removed
  }
}

function main() {
  try {
    const baseline = readJson(BASELINE_PATH)
    validateBaseline(baseline)
    const comparisonRef = baselineComparisonRef()
    const previousBaseline = readBaselineAtRef(comparisonRef)
    if (previousBaseline) {
      const currentSourcePaths = new Set(
        Object.keys(previousBaseline.hotspotBudgets).filter((filePath) =>
          fs.existsSync(path.join(REPO_ROOT, filePath))
        )
      )
      const monotonicityFailures = baselineMonotonicityFailures(previousBaseline, baseline, {
        currentSourcePaths
      })
      if (monotonicityFailures.length > 0) {
        console.error(
          `[architecture-guard] FAILED — baseline weakens ${comparisonRef}; ratchets are monotonic:`
        )
        for (const failure of monotonicityFailures) console.error(`  ✗ ${failure}`)
        process.exitCode = 1
        return
      }
    } else {
      console.log(
        `[architecture-guard] baseline bootstrap: ${comparisonRef} does not contain ${BASELINE_REPO_PATH}`
      )
    }
    const currentEdges = collectRendererMainRuntimeEdges()
    const currentMainRendererSurface = collectMainRendererRuntimeSurface()
    const currentSharedUpwardEdges = collectSharedUpwardRuntimeEdges()
    const hotspotMeasurements = {}

    for (const filePath of Object.keys(baseline.hotspotBudgets)) {
      const absolutePath = path.join(REPO_ROOT, filePath)
      if (!fs.existsSync(absolutePath)) continue
      hotspotMeasurements[filePath] = measureSource(fs.readFileSync(absolutePath, 'utf8'), filePath)
    }

    const result = evaluateArchitecture({
      baseline,
      currentEdges,
      currentMainRendererEdges: currentMainRendererSurface.edges,
      currentMainComputedRuntimeLoads: currentMainRendererSurface.unsafeLoads,
      currentSharedUpwardEdges,
      hotspotMeasurements
    })
    if (result.failures.length > 0) {
      console.error('[architecture-guard] FAILED — architecture debt grew:')
      for (const failure of result.failures) console.error(`  ✗ ${failure}`)
      console.error(
        '\nMove cross-process contracts/pure helpers to src/shared or extract code from the hotspot. Raise a baseline only after explicit architecture review.'
      )
      process.exitCode = 1
      return
    }

    console.log(
      `[architecture-guard] ok — ${currentEdges.length} grandfathered renderer -> main runtime edges; no additions`
    )
    console.log(
      `  src/main -> renderer: ${currentMainRendererSurface.edges.length} runtime edges; ${currentMainRendererSurface.unsafeLoads.length} computed-loader allowances`
    )
    console.log(
      `  src/shared: ${currentSharedUpwardEdges.length} runtime edges to main/renderer (budget ${baseline.sharedUpwardRuntimeEdges.length})`
    )
    for (const [filePath, measurement] of Object.entries(hotspotMeasurements)) {
      const budget = baseline.hotspotBudgets[filePath]
      console.log(
        `  ${filePath}: ${measurement.lines}/${budget.maxLines} lines, ${measurement.branchPoints}/${budget.maxBranchPoints} branch points`
      )
    }
  } catch (error) {
    console.error(
      `[architecture-guard] FAILED — ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  collectRendererMainRuntimeEdges,
  collectMainRendererRuntimeSurface,
  collectSharedUpwardRuntimeEdges,
  baselineMonotonicityFailures,
  evaluateArchitecture,
  measureSource,
  physicalLineCount,
  runtimeModuleSpecifiers,
  runtimeModuleSurface,
  validateBaseline
}

if (require.main === module) main()
