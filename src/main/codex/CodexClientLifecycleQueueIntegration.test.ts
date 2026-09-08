import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const extracted = readFileSync(new URL('./CodexClientAcquisition.ts', import.meta.url), 'utf8')
const implementations = [extracted]
if (hasFunction(source, 'acquireCodexClientLifecycleLease')) implementations.push(source)

const functionCache = new Map<string, Map<string, string>>()

function functionText(text: string, name: string): string {
  let functions = functionCache.get(text)
  if (!functions) {
    functions = new Map()
    const file = ts.createSourceFile('integration.ts', text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        if (functions!.has(node.name.text)) {
          // Only queried names need to be unique; unrelated nested helpers may repeat.
          functions!.set(node.name.text, '')
        } else functions!.set(node.name.text, node.getText(file))
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    functionCache.set(text, functions)
  }
  const result = functions.get(name)
  expect(result, 'missing or ambiguous function: ' + name).toBeTruthy()
  return result!
}

// Dependency rebinding is explicit in the module. Ignore that prefix when
// checking the same ownership/order contract in the still-active legacy route.
function implementationText(text: string, name: string): string {
  return functionText(text, name).replace(/\bdeps\s*\.\s*/g, '')
}

function hasFunction(text: string, name: string): boolean {
  const file = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true)
  return file.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
}

function assertProductionAcquisitionBinding(text: string): void {
  const exports = [
    'acquireCodexClientLifecycleLease',
    'getCodexClient',
    'acquireCodexProviderClientRunLease'
  ]
  const declarations = [...exports, 'resolveCodexClientStartupConfiguration']
  const file = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true)
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createCodexClientAcquisition'
    )
      calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const legacy = declarations.filter((name) =>
    file.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  )
  if (legacy.length) {
    // The existing route must be complete; partial cutover is not an alternative.
    expect(legacy).toEqual(declarations)
    expect(calls).toHaveLength(0)
    return
  }
  expect(calls).toHaveLength(1)
  const call = calls[0]
  expect(
    file.statements.some(
      (node) =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './codex/CodexClientAcquisition' &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (binding) =>
            binding.name.text === 'createCodexClientAcquisition' &&
            (!binding.propertyName || binding.propertyName.text === binding.name.text)
        )
    )
  ).toBe(true)
  expect(ts.isVariableDeclaration(call.parent)).toBe(true)
  const declaration = call.parent as ts.VariableDeclaration
  expect(ts.isObjectBindingPattern(declaration.name)).toBe(true)
  const names = (declaration.name as ts.ObjectBindingPattern).elements.map((element) =>
    element.getText(file)
  )
  expect(names).toEqual(exports)
  expect(call.arguments).toHaveLength(1)
  expect(ts.isObjectLiteralExpression(call.arguments[0])).toBe(true)
  const deps = call.arguments[0] as ts.ObjectLiteralExpression
  const compact = (value: string): string => value.replace(/[\s;]/g, '')
  // Pin live binding for every port in the preserved extraction registration.
  // A copied startup count or a second client/queue would split production ownership.
  const ports = [
    'codexProviderClientCohorts',
    'codexClientLifecycleQueue',
    'activeCodexClientLifecycleLease',
    'poisonWorkspaceLockMutationAdmission',
    'AppStore',
    'taskwraithMcpBridgeCommandStatus',
    'buildUserMcpLaunchServers',
    'managedUserMcpLaunchAllowlistPolicy',
    'validateUserMcpPluginProvenance',
    'TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID',
    'taskwraithMcpBridgeArgs',
    'geminiMcpSocketPath',
    'isGatewayTaskWraithMcpProfile',
    'isSoloTaskWraithMcpProfile',
    'isPortableEnsembleControlMcpProfile',
    'isMeshCanvasDirectTaskWraithMcpProfile',
    'isMeshTopologyDirectTaskWraithMcpProfile',
    'isSketchCanvasDirectTaskWraithMcpProfile',
    'isGatewayV13DirectTaskWraithMcpProfile',
    'isPermissionOpportunityDirectTaskWraithMcpProfile',
    'createHash',
    'codexClient',
    'taskWraithCodexHome',
    'process',
    'acquireCodexCredentialLeaseIfConsented',
    'shouldRestartCodexAppServerForMcpConfig',
    'codexAppServerStartupLeaseCount',
    'runManager',
    'codexThreadAdmissionRegistry',
    'console',
    'disposeCodexClientForOwnerTransition',
    'finishCodexClientLifecycle',
    'CodexClientLifecycleAcquireAbortedError',
    'CodexAppServerClient'
  ]
  for (const name of ports) {
    const getters = deps.properties.filter(
      (member) => ts.isGetAccessorDeclaration(member) && member.name.getText(file) === name
    ) as ts.GetAccessorDeclaration[]
    expect(getters, 'live getter: ' + name).toHaveLength(1)
    expect(compact(getters[0].body!.getText(file))).toBe('{return' + name + '}')
  }
  for (const name of ['codexClient', 'activeCodexClientLifecycleLease']) {
    const setters = deps.properties.filter(
      (member) => ts.isSetAccessorDeclaration(member) && member.name.getText(file) === name
    ) as ts.SetAccessorDeclaration[]
    expect(setters, 'shared setter: ' + name).toHaveLength(1)
    expect(setters[0].parameters).toHaveLength(1)
    const parameter = setters[0].parameters[0].name.getText(file)
    expect(compact(setters[0].body!.getText(file))).toBe('{' + name + '=' + parameter + '}')
  }
}

describe('Codex client lifecycle queue integration', () => {
  it('keeps one complete active acquisition route with shared live ownership bindings', () => {
    assertProductionAcquisitionBinding(source)
  })

  it('rejects mixing the legacy route with a second factory or duplicating the wired factory', () => {
    expect(() =>
      assertProductionAcquisitionBinding(
        source + '\nconst duplicate = createCodexClientAcquisition({})'
      )
    ).toThrow()
  })

  it('waits through the abortable FIFO instead of a bare promise tail', () => {
    expect(source).toContain('const codexClientLifecycleQueue = new CodexClientLifecycleQueue()')
    for (const text of implementations) {
      const acquire = implementationText(text, 'acquireCodexClientLifecycleLease')
      expect(acquire).toContain('codexClientLifecycleQueue.enqueue()')
      expect(acquire).toContain('queueSlot.waitUntilAcquired(signal)')
      expect(acquire).toContain('queueSlot.release()')
      expect(acquire).not.toContain('Promise.race')
    }
    expect(source).not.toContain('codexClientLifecycleTail')
  })

  it('makes provider setup cancellation abort the lifecycle wait without exec fallback', () => {
    for (const text of implementations) {
      const providerLease = implementationText(text, 'acquireCodexProviderClientRunLease')
      expect(providerLease).toContain('payload.providerSetupAbortSignal')
    }
    const provider = functionText(source, 'runCodexProvider')
    const abortCatch = provider.indexOf(
      'if (error instanceof CodexClientLifecycleAcquireAbortedError)'
    )
    const fallback = provider.indexOf('await runCodexExecFallback(')
    expect(abortCatch).toBeGreaterThanOrEqual(0)
    expect(abortCatch).toBeLessThan(fallback)
    expect(provider.slice(abortCatch, fallback)).toContain('settleDeniedProviderTransportLaunch(')
    expect(provider.slice(abortCatch, fallback)).toContain('return')
  })
})
