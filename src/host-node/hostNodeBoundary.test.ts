import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const REPO_ROOT = resolve(process.cwd())
const HOST_NODE_ROOT = resolve(REPO_ROOT, 'src/host-node')
const HOST_RUNTIME_ROOT = resolve(REPO_ROOT, 'src/host-runtime')
const SHARED_ROOT = resolve(REPO_ROOT, 'src/shared')
const HOST_SHARED_ROOT = resolve(REPO_ROOT, 'src/host-shared')
const MAIN_MUSE_ROOT = resolve(REPO_ROOT, 'src/main/muse')
const MAIN_MISTRAL_ROOT = resolve(REPO_ROOT, 'src/main/mistral')
const MAIN_DEVIN_ROOT = resolve(REPO_ROOT, 'src/main/devin')
const HOST_NODE_AGY_PTY_CAPTURE = resolve(HOST_NODE_ROOT, 'HostNodeAgyPtyCapture.ts')
const ROOT_MODULES = [
  resolve(HOST_NODE_ROOT, 'HostNodeMuseProvider.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProfileRunPort.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeDomainPorts.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProductionServer.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProductionFactory.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeMuseResources.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeMuseCatalog.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeMuseAuthHandoff.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProvider.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProviderRegistry.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeInteractionRegistry.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProviderResources.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeTerminalLauncher.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeTerminalWindowLauncher.ts'),
  resolve(HOST_SHARED_ROOT, 'HostProviderCatalog.ts')
]

/** Deliberate production closure required by the Node Muse adapter. */
const PURE_MUSE_CLOSURE = new Set([
  'MuseCliArgs.ts',
  'MuseCronAssert.ts',
  'MuseExecJson.ts',
  'MuseIsolatedHome.ts',
  'MuseMcpConfig.ts',
  'MuseProbe.ts',
  'MuseRun.ts',
  'MuseSessionLog.ts',
  'MuseSkillPin.ts',
  'MuseToolProjection.ts',
  'MuseTypes.ts',
  'MuseUsage.ts'
])

/** Deliberate production closure required by the Node Mistral adapter. */
const PURE_MISTRAL_CLOSURE = new Set([
  'MistralCliArgs.ts',
  'MistralCredentialLane.ts',
  'MistralQuotaEstimate.ts'
])

/** Deliberate production closure required by the Node Devin adapter: launch
 *  policy, the three credential lanes, and the credentials.toml reader. The
 *  ACP client and the env gates stay main-only (they pull Electron surfaces). */
const PURE_DEVIN_CLOSURE = new Set([
  'DevinCliArgs.ts',
  'DevinCredentialLane.ts',
  'DevinCredentialStore.ts'
])

const PINNED_MAIN_PROVIDER_CLOSURES = new Map<string, ReadonlySet<string>>([
  [MAIN_MUSE_ROOT, PURE_MUSE_CLOSURE],
  [MAIN_MISTRAL_ROOT, PURE_MISTRAL_CLOSURE],
  [MAIN_DEVIN_ROOT, PURE_DEVIN_CLOSURE]
])

const PINNED_EXTERNAL_IMPORTS = new Map<string, ReadonlySet<string>>([
  [HOST_NODE_AGY_PTY_CAPTURE, new Set(['node-pty'])]
])

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.includes('../'))
}

function resolveRelativeModule(containingFile: string, specifier: string): string {
  const base = resolve(dirname(containingFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`Host Node boundary could not resolve ${specifier} from ${containingFile}`)
}

function moduleSpecifier(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null
}

function collectImports(source: ts.SourceFile): string[] {
  const imports: string[] = []
  const forbiddenCalls: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifier(node)
      if (specifier) imports.push(specifier)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (node.arguments.length === 1 && argument && ts.isStringLiteral(argument)) {
        imports.push(argument.text)
      } else {
        forbiddenCalls.push(node.getText(source))
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      forbiddenCalls.push(node.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (forbiddenCalls.length) {
    throw new Error(
      `Host Node provider closure forbids non-literal dynamic import/require: ${forbiddenCalls.join(', ')}`
    )
  }
  return imports
}

function isPinnedMainProviderModule(path: string): boolean {
  for (const [root, modules] of PINNED_MAIN_PROVIDER_CLOSURES) {
    if (isWithin(path, root) && modules.has(relative(root, path))) return true
  }
  return false
}

describe('HostNode import boundary', () => {
  it('uses only Node, host-runtime/shared, and pinned pure provider closures', async () => {
    const pending = [...ROOT_MODULES]
    const visited = new Set<string>()
    while (pending.length) {
      const file = pending.pop()
      if (!file || visited.has(file)) continue
      visited.add(file)
      const sourceText = await readFile(file, 'utf8')
      expect(sourceText).not.toMatch(/from\s+['"]electron['"]|require\s*\(\s*['"]electron['"]\s*\)/)
      const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true)
      for (const specifier of collectImports(source)) {
        if (specifier.startsWith('node:')) continue
        if (!specifier.startsWith('.')) {
          if (PINNED_EXTERNAL_IMPORTS.get(file)?.has(specifier)) continue
          throw new Error(`Host Node provider closure forbids external import ${specifier}`)
        }
        const target = resolveRelativeModule(file, specifier)
        if (
          isWithin(target, HOST_NODE_ROOT) ||
          isWithin(target, HOST_RUNTIME_ROOT) ||
          isWithin(target, SHARED_ROOT) ||
          isWithin(target, HOST_SHARED_ROOT)
        ) {
          pending.push(target)
          continue
        }
        if (isPinnedMainProviderModule(target)) {
          pending.push(target)
          continue
        }
        throw new Error(
          `Host Node provider closure imports forbidden module ${relative(REPO_ROOT, target)}`
        )
      }
    }

    for (const [root, expected] of PINNED_MAIN_PROVIDER_CLOSURES) {
      expect(
        [...visited]
          .filter((path) => isWithin(path, root))
          .map((path) => relative(root, path))
          .sort()
      ).toEqual([...expected].sort())
    }
  })
})
