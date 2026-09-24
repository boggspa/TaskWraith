// Source-level contract for the brokered shell sandbox wiring in `index.ts`.
//
// `index.ts` is the Electron main entry — importing it boots the app — so this
// wiring cannot be exercised directly. The established idiom here is to read the
// source and assert on it; see `index.ts containment wiring` in
// `ShellSandboxProfile.test.ts`, which caught a Seatbelt wired into one of two
// spawn families.
//
// Two rules keep that idiom honest. Assertions are scoped to ONE function body
// wherever they can be: a whole-file `toContain` is close to vacuous in a
// 63,000-line module, where `executableExternalPathGrantsForRun` alone appears a
// dozen times and a file-wide check for it would stay green with the fix
// deleted. And where a thing must appear at BOTH call sites, these tests COUNT
// it — asserting mere presence passed once while one of two identical call sites
// had been removed.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function topLevelFunctionSource(declaration: string): string {
  const start = indexSource.indexOf(declaration)
  if (start < 0) throw new Error(`index.ts no longer declares: ${declaration}`)
  // Every brace inside a top-level function is indented, so the first line that
  // is exactly `}` closes it.
  const end = indexSource.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`could not find the end of: ${declaration}`)
  return indexSource.slice(start, end)
}

const planSource = topLevelFunctionSource('function brokeredShellSandboxPlan(input: {')
const warnSource = topLevelFunctionSource('function warnOnceOnUnenforceableShellSandbox(')
const warnMessageSource = warnSource.slice(warnSource.indexOf('console.warn('))

// The arguments given at each `shellSandbox:` call site, so a field can be
// counted across sites instead of merely found somewhere in the file.
const planCallSiteArguments = indexSource
  .split('shellSandbox: brokeredShellSandboxPlan({')
  .slice(1)
  .map((tail) => tail.slice(0, tail.indexOf('})')))

describe('index.ts brokered shell sandbox — external write grants', () => {
  // The Seatbelt is a second permission system under TaskWraith's own, so a
  // write path the user explicitly granted has to be re-granted in the profile.
  // `executableExternalPathGrantsForChat` documents that "with no run id,
  // `thisRun` grants also fail closed" — reading it alone left every `thisRun`
  // write grant, the narrowest and most deliberate form the user can give, out
  // of the profile, and the kernel denied the write.
  it('resolves grants from the run accessor as well as the thread accessor', () => {
    expect(planSource).toContain('executableExternalPathGrantsForChat(chat, input.provider)')
    expect(planSource).toContain('executableExternalPathGrantsForRun(chat, input.appRunId)')
  })

  it('threads the run id in from every brokered call site, not just one', () => {
    const threaded = planCallSiteArguments.filter((args) =>
      args.includes('appRunId: workspaceExecutionContext.appRunId')
    ).length
    expect(`sites=${planCallSiteArguments.length},threaded=${threaded}`).toBe('sites=2,threaded=2')
  })

  it('de-duplicates a grant that legitimately appears in both accessors', () => {
    expect(planSource).toContain('new Map<string, ExternalPathGrant>()')
    expect(planSource).toContain('.has(target)')
    expect(planSource).toContain('.set(target, grant)')
  })

  // Merging must not widen what reaches the profile: read grants stay out, and a
  // directory grant must not be emitted as a file literal or the reverse.
  it('still admits write grants only, split by directory and file kind', () => {
    expect(planSource).toContain(".filter((grant) => grant.access === 'write')")
    expect(planSource).toContain("(grant) => grant.kind === 'directory'")
    expect(planSource).toContain("(grant) => grant.kind === 'file'")
    expect(planSource).toContain('externalWritableDirectories: grants')
    expect(planSource).toContain('externalWritableFiles: grants')
  })
})

describe('index.ts brokered shell sandbox — unenforceable containment warning', () => {
  // An `enforced` plan refuses every shell command, run_task and background
  // process in the workspace. The refusal text is actionable, but nothing
  // surfaces until the first tool call, so a configuration that can never work
  // looks fine until an agent trips over it.
  it('warns from the one place every projection scope resolves its plan', () => {
    expect(planSource).toContain('warnOnceOnUnenforceableShellSandbox(plan')
  })

  it('warns only when containment was asked for and could not be delivered', () => {
    expect(warnSource).toContain('if (plan.sandboxed || !plan.enforced) return')
  })

  it('warns once per key rather than once per tool call', () => {
    expect(indexSource).toContain('const warnedUnenforceableShellSandboxes = new Set<string>()')
    expect(warnSource).toContain('if (warnedUnenforceableShellSandboxes.has(key)) return')
    expect(warnSource).toContain('warnedUnenforceableShellSandboxes.add(key)')
  })

  it('names the reason and the workspace path in the warning itself', () => {
    expect(warnMessageSource).toContain('${plan.reason}')
    expect(warnMessageSource).toContain('${workspacePath')
  })
})

// Every enforced reason must carry an actionable remedy AND its detail. A
// generic "set the env var to 0" for a condition the user could fix by
// renaming a directory points them at disabling the feature instead.
describe('refusal message covers every enforced reason', () => {
  const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const start = indexSource.indexOf('function shellSandboxRefusalMessage(')
  const body = indexSource.slice(start, indexSource.indexOf('\n}', start))

  it('gives each enforced reason its own remedy', () => {
    for (const reason of [
      'unsafe_workspace_root',
      'sandbox_binary_unavailable',
      'profile_build_failed'
    ]) {
      expect(`${reason}:${body.includes(`'${reason}'`)}`).toBe(`${reason}:true`)
    }
  })

  it('surfaces plan.detail in every one of those branches', () => {
    const branches = body.split('plan.reason ===').length - 1
    const details = body.split('plan.detail').length - 1
    expect(`branches:${branches} details:${details}`).toBe(`branches:3 details:3`)
  })
})
