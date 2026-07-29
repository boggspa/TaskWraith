#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Deliberately narrow: this gate encodes the recurring host-canonical MCP
// fixture defect from the 1.9.1 Windows rounds. Command-path portability,
// POSIX-mode assertions, inode replacement, and binary equality are separate
// invariants with different sinks and exemptions; a blanket path grep would
// turn their legitimate fixtures into noise.
const GUARDED_FIXTURE_FILES = Object.freeze([
  'src/main/devAppName.test.ts',
  'src/main/mcp/McpBridgeRoute.test.ts',
  'src/main/mcp/McpBridgeRuntimeInstanceIsolation.test.ts',
  'src/main/mcp/McpBridgeRuntimeSafeWrite.test.ts'
])

// These values deliberately exercise rejection or redaction. They do not model
// a host-canonical path accepted by the guarded reader.
const INTENTIONAL_NON_CANONICAL_FIXTURES = new Set([
  '/Applications/TaskWraith Dev.app/Contents/Resources/../Resources/app.asar',
  '/Applications/__BRIDGE_APP_PATH_SENTINEL__.app/Contents/app.asar',
  '/Applications/__PERSISTED_APP_SENTINEL__.app/Contents/app.asar',
  '/tmp/__BRIDGE_SOCKET_SENTINEL__.sock'
])

function templateValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (!ts.isTemplateExpression(node)) return null
  return (
    node.head.text + node.templateSpans.map((span) => `\${expression}${span.literal.text}`).join('')
  )
}

function isGuardedPathShape(value) {
  if (!value.startsWith('/')) return false
  return value.endsWith('.sock') || /\.app\/.*\/app\.asar$/.test(value)
}

function isResolveCall(node) {
  if (!ts.isCallExpression(node)) return false
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'resolve'
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve'
}

function isWrappedInResolve(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isResolveCall(current)) return true
    if (ts.isSourceFile(current)) return false
  }
  return false
}

function collectPlatformPathLiteralViolations(sourceText, fileName = '<source>') {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const violations = []

  const visit = (node) => {
    const value = templateValue(node)
    if (
      value !== null &&
      isGuardedPathShape(value) &&
      !INTENTIONAL_NON_CANONICAL_FIXTURES.has(value) &&
      !isWrappedInResolve(node)
    ) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({
        fileName,
        line: location.line + 1,
        column: location.character + 1,
        value
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function inspectGuardedFixtureFiles(repoRoot, relativePaths = GUARDED_FIXTURE_FILES) {
  return relativePaths.flatMap((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath)
    const sourceText = fs.readFileSync(absolutePath, 'utf8')
    return collectPlatformPathLiteralViolations(sourceText, relativePath)
  })
}

function renderViolation(violation) {
  return (
    `${violation.fileName}:${violation.line}:${violation.column} ` +
    `host-canonical MCP fixture ${JSON.stringify(violation.value)} must be wrapped in resolve(...)`
  )
}

function main() {
  const repoRoot = path.resolve(__dirname, '..')
  const violations = inspectGuardedFixtureFiles(repoRoot)
  if (violations.length === 0) {
    process.stdout.write(
      `[platform-path-literal-guard] ${GUARDED_FIXTURE_FILES.length} guarded fixture files passed\n`
    )
    return 0
  }
  process.stderr.write(`${violations.map(renderViolation).join('\n')}\n`)
  return 1
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = {
  collectPlatformPathLiteralViolations,
  GUARDED_FIXTURE_FILES,
  inspectGuardedFixtureFiles,
  INTENTIONAL_NON_CANONICAL_FIXTURES,
  renderViolation
}
