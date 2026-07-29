import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  collectPlatformPathLiteralViolations,
  GUARDED_FIXTURE_FILES,
  inspectGuardedFixtureFiles,
  INTENTIONAL_NON_CANONICAL_FIXTURES
}: {
  collectPlatformPathLiteralViolations: (
    sourceText: string,
    fileName?: string
  ) => Array<{ fileName: string; line: number; column: number; value: string }>
  GUARDED_FIXTURE_FILES: readonly string[]
  inspectGuardedFixtureFiles: (
    repoRoot: string,
    relativePaths?: readonly string[]
  ) => Array<{ fileName: string; line: number; column: number; value: string }>
  INTENTIONAL_NON_CANONICAL_FIXTURES: ReadonlySet<string>
} = require('./platform-path-literal-guard.cjs')

describe('platform path literal guard', () => {
  it('rejects plain and template POSIX literals that would fail host canonicality on Windows', () => {
    const violations = collectPlatformPathLiteralViolations(
      [
        "const socketPath = '/private/primary/taskwraith-gemini-mcp.sock'",
        'const isolatedSocketPath = `/private/TaskWraith Instances/${id}/taskwraith.sock`',
        "const appPath = '/Applications/TaskWraith Dev.app/Contents/Resources/app.asar'"
      ].join('\n'),
      'fixture.test.ts'
    )

    expect(violations.map((violation) => violation.value)).toEqual([
      '/private/primary/taskwraith-gemini-mcp.sock',
      '/private/TaskWraith Instances/${expression}/taskwraith.sock',
      '/Applications/TaskWraith Dev.app/Contents/Resources/app.asar'
    ])
  })

  it('accepts the same guarded fixture shapes when composed through path.resolve', () => {
    expect(
      collectPlatformPathLiteralViolations(
        [
          "const socketPath = resolve('/private/primary/taskwraith-gemini-mcp.sock')",
          'const isolatedSocketPath = path.resolve(`/private/${id}/taskwraith.sock`)',
          "const appPath = resolve('/Applications/TaskWraith Dev.app/Contents/Resources/app.asar')"
        ].join('\n')
      )
    ).toEqual([])
  })

  it('keeps explicit rejection/redaction fixtures and unrelated paths out of the rule', () => {
    const intentional = [...INTENTIONAL_NON_CANONICAL_FIXTURES]
      .map((value, index) => `const intentional${index} = ${JSON.stringify(value)}`)
      .join('\n')
    const sourceText = [
      intentional,
      "const workspacePath = '/Users/example/workspace'",
      "const executablePath = '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'"
    ].join('\n')

    expect(collectPlatformPathLiteralViolations(sourceText)).toEqual([])
  })

  it('keeps every currently guarded production fixture file clean', () => {
    expect(GUARDED_FIXTURE_FILES.length).toBeGreaterThan(0)
    expect(inspectGuardedFixtureFiles(process.cwd())).toEqual([])
  })
})
