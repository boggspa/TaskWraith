import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(process.cwd())
const HOST_RUNTIME_ROOT = resolve(REPO_ROOT, 'src/host-runtime')
const FORBIDDEN_SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'src/main'),
  resolve(REPO_ROOT, 'src/renderer'),
  resolve(REPO_ROOT, 'src/tui')
]
const REQUIRED_RUNTIME_MODULES = [
  'HostRuntimeBootstrap.ts',
  'HostDeltaStore.ts',
  'HostCommandReceiptStore.ts',
  'HostDeferredCommandEnvelopeStore.ts',
  'HostCommandArguments.ts',
  'HostCommandFingerprint.ts',
  'HostCommandRouting.ts'
] as const
const LEGACY_MAIN_HOST_MODULES = REQUIRED_RUNTIME_MODULES.map((name) =>
  resolve(REPO_ROOT, 'src/main/host', name)
)
const REQUIRED_MAIN_HOST_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  'src/main/host/HostMainComposition.ts': [
    '../../host-runtime/HostRuntimeBootstrap',
    '../../host-runtime/HostDeltaStore'
  ],
  'src/main/host/HostProductionBootstrap.ts': ['../../host-runtime/HostRuntimeBootstrap'],
  'src/main/host/AppStoreHostAuthority.ts': [
    '../../host-runtime/HostCommandFingerprint',
    '../../host-runtime/HostCommandRouting',
    '../../host-runtime/HostDeferredCommandEnvelopeStore',
    '../../host-runtime/HostCommandReceiptStore',
    '../../host-runtime/HostRuntimeBootstrap'
  ],
  'src/main/host/HostDeferredCommandEnvelopeResolver.ts': [
    '../../host-runtime/HostCommandArguments',
    '../../host-runtime/HostCommandFingerprint',
    '../../host-runtime/HostCommandRouting',
    '../../host-runtime/HostDeferredCommandEnvelopeStore',
    '../../host-runtime/HostCommandReceiptStore'
  ]
}
const AUTHENTICATED_TRANSPORT_CORE = [
  resolve(HOST_RUNTIME_ROOT, 'HostAuthority.ts'),
  resolve(HOST_RUNTIME_ROOT, 'HostSession.ts'),
  resolve(HOST_RUNTIME_ROOT, 'HostLocalServer.ts')
]
const DIAGNOSTIC_HOST_RUNTIME = [
  resolve(HOST_RUNTIME_ROOT, 'HostDiagnosticAuthority.ts'),
  resolve(HOST_RUNTIME_ROOT, 'HostDiagnosticCli.ts'),
  resolve(HOST_RUNTIME_ROOT, 'HostDiagnosticServer.ts'),
  resolve(HOST_RUNTIME_ROOT, 'cli.ts')
]

function isProductionSource(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts')
}

async function productionHostRuntimeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const children = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return productionHostRuntimeFiles(path)
      return entry.isFile() && isProductionSource(entry.name) ? [path] : []
    })
  )
  return children.flat()
}

function runtimeModuleSpecifiers(path: string, source: string): string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return specifiers
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
}

function forbiddenImport(importer: string, specifier: string): boolean {
  if (specifier === 'electron' || specifier.startsWith('electron/')) return true
  if (!specifier.startsWith('.')) return false
  const resolved = resolve(dirname(importer), specifier)
  return FORBIDDEN_SOURCE_ROOTS.some((root) => isInside(root, resolved))
}

describe('standalone Host runtime boundary', () => {
  it('includes authenticated transport and diagnostic Host modules in the standalone import audit', async () => {
    expect(await productionHostRuntimeFiles(HOST_RUNTIME_ROOT)).toEqual(
      expect.arrayContaining([...AUTHENTICATED_TRANSPORT_CORE, ...DIAGNOSTIC_HOST_RUNTIME])
    )
  })

  it('does not import Electron or presentation/composition roots', async () => {
    const files = await productionHostRuntimeFiles(HOST_RUNTIME_ROOT)
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const source = await readFile(file, 'utf8')
          return runtimeModuleSpecifiers(file, source)
            .filter((specifier) => forbiddenImport(file, specifier))
            .map((specifier) => `${relative(REPO_ROOT, file)} -> ${specifier}`)
        })
      )
    ).flat()

    expect(violations).toEqual([])
  })

  it('owns the durable journal and command-validation closure rather than compatibility copies', async () => {
    const files = await productionHostRuntimeFiles(HOST_RUNTIME_ROOT)
    const names = files.map((file) => file.slice(file.lastIndexOf('/') + 1))
    expect(names).toEqual(expect.arrayContaining(REQUIRED_RUNTIME_MODULES))

    const legacyStillPresent = (
      await Promise.all(
        LEGACY_MAIN_HOST_MODULES.map(async (path) => {
          try {
            await readFile(path, 'utf8')
            return path
          } catch {
            return null
          }
        })
      )
    ).filter((path): path is string => path !== null)
    expect(legacyStillPresent).toEqual([])
  })

  it('keeps main-host composition and deferred consumers pointed directly at runtime modules', async () => {
    const missing = (
      await Promise.all(
        Object.entries(REQUIRED_MAIN_HOST_CONSUMERS).map(async ([relativePath, expected]) => {
          const source = await readFile(resolve(REPO_ROOT, relativePath), 'utf8')
          const actual = runtimeModuleSpecifiers(resolve(REPO_ROOT, relativePath), source)
          return expected
            .filter((specifier) => !actual.includes(specifier))
            .map((specifier) => `${relativePath} -> ${specifier}`)
        })
      )
    ).flat()
    expect(missing).toEqual([])
  })
})
