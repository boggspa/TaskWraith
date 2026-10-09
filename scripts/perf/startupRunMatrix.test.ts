import { spawnSync } from 'node:child_process'
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type Context = { homesRoot?: string; home?: string; rm?: (dir: string, options: object) => void }
// Loading the script runs nothing: it only runs as a command.
const matrix = require('./startupRunMatrix.cjs') as {
  AUTHORITY_ROOT_PREFIX: string
  ISOLATED_HOMES: string
  authorityRootRefusal: (root: string, context?: Context) => string | null
  profileDirFor: (instanceId: string, home?: string) => string
  profileDirRefusal: (dir: string, context?: Context) => string | null
  removeAuthorityRoot: (root: string, context?: Context) => void
  removeProfileDir: (dir: string, context?: Context) => void
}

/** Every directory this file makes is named so, directly in the temporary folder. */
const PREFIX = 'harness-startup-matrix-'
const made: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), PREFIX))
  made.push(dir)
  return dir
}

afterEach(() => {
  // First, so that the cleanup below removes for real.
  vi.restoreAllMocks()
  while (made.length > 0) {
    const dir = made.pop()!
    if (dir === tmpdir() || !dir.startsWith(tmpdir() + path.sep + PREFIX)) {
      throw new Error(`refusing to remove ${dir}: not a directory this file made`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A removal that only records what it was asked to remove. */
function recorder() {
  const asked: string[] = []
  return { asked, rm: (dir: string) => void asked.push(dir) }
}

/**
 * The file system's own removal, made to record instead: nothing here is
 * removed but the directories this file made, and those only by its cleanup.
 */
function recordFileSystemRemovals() {
  const asked: Array<[string, unknown]> = []
  vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    asked.push([String(target), options])
  })
  return asked
}

/**
 * A stand-in for the machine: a home with an Application Support folder, and
 * the harness's isolated homes beside it, all inside one directory of this
 * file's own.
 */
function machine() {
  const tree = makeDirectory()
  const home = path.join(tree, 'home')
  const appSupport = path.join(home, 'Library', 'Application Support')
  const homesRoot = path.join(tree, 'perf-homes')
  mkdirSync(appSupport, { recursive: true })
  mkdirSync(homesRoot)
  return { tree, home, appSupport, homesRoot }
}

describe('the authority root the matrix may wipe for --seed-wal', () => {
  it('is a folder under the harness’s isolated homes whose name has the fixed prefix', () => {
    const { home, homesRoot } = machine()
    const root = path.join(homesRoot, `${matrix.AUTHORITY_ROOT_PREFIX}run-1`)
    mkdirSync(path.join(root, 'work-lock-authority'), { recursive: true })
    expect(matrix.authorityRootRefusal(root, { home, homesRoot })).toBeNull()
    const asked = recordFileSystemRemovals()
    matrix.removeAuthorityRoot(root, { home, homesRoot })
    expect(asked).toEqual([[root, { recursive: true, force: true }]])
  })

  it('may be a folder that is not there yet: the run creates it and removes nothing', () => {
    const { home, homesRoot, tree } = machine()
    expect(matrix.authorityRootRefusal(path.join(tree, 'new-root'), { home, homesRoot })).toBeNull()
    const { asked, rm } = recorder()
    matrix.removeAuthorityRoot(path.join(tree, 'new-root'), { home, homesRoot, rm })
    expect(asked).toEqual([])
  })

  it('is never the home, an Application Support folder, or a folder above either', () => {
    const { home, appSupport, homesRoot, tree } = machine()
    const { asked, rm } = recorder()
    const refusals: Array<[string, string]> = [
      [home, 'home_or_application_support_or_above'],
      [appSupport, 'home_or_application_support_or_above'],
      [path.join(home, 'Library'), 'home_or_application_support_or_above'],
      [tree, 'home_or_application_support_or_above'],
      [path.dirname(tree), 'home_or_application_support_or_above'],
      [path.parse(tree).root, 'home_or_application_support_or_above'],
      [path.join(appSupport, 'TaskWraith'), 'inside_application_support'],
      [path.join(appSupport, 'not-there-yet'), 'inside_application_support'],
      // The same folders by where they lead: the temporary folder is itself reached through a link.
      [realpathSync(home), 'home_or_application_support_or_above'],
      [path.join(realpathSync(appSupport), 'TaskWraith'), 'inside_application_support']
    ]
    for (const [root, reason] of refusals) {
      expect(matrix.authorityRootRefusal(root, { home, homesRoot })).toBe(reason)
      expect(() => matrix.removeAuthorityRoot(root, { home, homesRoot, rm })).toThrow(
        /refusing to remove/
      )
    }
    expect(asked).toEqual([])
  })

  it('is never the home by where it leads when its Library is a link out of it', () => {
    const { tree, homesRoot } = machine()
    const home = path.join(tree, 'linked-home')
    const library = path.join(tree, 'library-elsewhere')
    mkdirSync(path.join(library, 'Application Support'), { recursive: true })
    mkdirSync(home)
    symlinkSync(library, path.join(home, 'Library'))
    const { asked, rm } = recorder()
    const refusals: Array<[string, string]> = [
      [realpathSync(home), 'home_or_application_support_or_above'],
      [
        realpathSync(path.join(library, 'Application Support')),
        'home_or_application_support_or_above'
      ],
      [realpathSync(library), 'home_or_application_support_or_above']
    ]
    for (const [root, reason] of refusals) {
      expect(matrix.authorityRootRefusal(root, { home, homesRoot })).toBe(reason)
      expect(() => matrix.removeAuthorityRoot(root, { home, homesRoot, rm })).toThrow(
        /refusing to remove/
      )
    }
    expect(asked).toEqual([])
  })

  it('is never an existing folder elsewhere, without the prefix, or reached through a link', () => {
    const { home, homesRoot, tree } = machine()
    const { asked, rm } = recorder()
    const elsewhere = path.join(tree, 'elsewhere')
    const unprefixed = path.join(homesRoot, 'run-1')
    const bare = path.join(homesRoot, matrix.AUTHORITY_ROOT_PREFIX)
    const nested = path.join(homesRoot, 'deeper', `${matrix.AUTHORITY_ROOT_PREFIX}run-1`)
    const linkedHome = path.join(homesRoot, `${matrix.AUTHORITY_ROOT_PREFIX}link`)
    const linkToAllowed = path.join(tree, 'link-to-allowed')
    const allowed = path.join(homesRoot, `${matrix.AUTHORITY_ROOT_PREFIX}real`)
    const sameNameElsewhere = path.join(tree, path.basename(allowed))
    const linkOut = path.join(homesRoot, `${matrix.AUTHORITY_ROOT_PREFIX}out`)
    for (const dir of [elsewhere, unprefixed, bare, nested, allowed])
      mkdirSync(dir, { recursive: true })
    symlinkSync(home, linkedHome)
    symlinkSync(allowed, linkToAllowed)
    symlinkSync(allowed, sameNameElsewhere)
    symlinkSync(elsewhere, linkOut)
    const refusals: Array<[string, string]> = [
      [elsewhere, 'not_in_isolated_homes'],
      [nested, 'not_in_isolated_homes'],
      [linkToAllowed, 'not_in_isolated_homes'],
      [sameNameElsewhere, 'not_in_isolated_homes'],
      [linkOut, 'not_in_isolated_homes'],
      [unprefixed, 'name_without_prefix'],
      [bare, 'name_without_prefix'],
      [linkedHome, 'home_or_application_support_or_above'],
      ['relative/root', 'not_a_plain_absolute_path'],
      [`${allowed}/../${path.basename(allowed)}`, 'not_a_plain_absolute_path']
    ]
    for (const [root, reason] of refusals) {
      expect(matrix.authorityRootRefusal(root, { home, homesRoot })).toBe(reason)
      expect(() => matrix.removeAuthorityRoot(root, { home, homesRoot, rm })).toThrow(
        /refusing to remove/
      )
    }
    expect(asked).toEqual([])
    expect(existsSync(home)).toBe(true)
  })

  it('lives in the checkout’s perf-homes by default', () => {
    expect(matrix.ISOLATED_HOMES).toBe(path.resolve(__dirname, '..', '..', 'perf-homes'))
    expect(matrix.AUTHORITY_ROOT_PREFIX).toBe('startup-authority-')
  })
})

describe('the instance profile the matrix removes for a cold run and at its end', () => {
  it('is the instance’s own TaskWraith Dev profile in Application Support', () => {
    const { home, appSupport } = machine()
    const dir = matrix.profileDirFor('perf-startup-abcdefghijklmnop', home)
    // The app names the profile by the first sixteen characters of the id.
    expect(dir).toBe(path.join(appSupport, 'TaskWraith Dev perf-startup-abc'))
    expect(matrix.profileDirRefusal(dir, { home })).toBeNull()
    const asked = recordFileSystemRemovals()
    matrix.removeProfileDir(dir, { home })
    expect(asked).toEqual([[dir, { recursive: true, force: true }]])
  })

  it('is never the real app’s profile, another folder, or a path that is not plain', () => {
    const { home, appSupport, tree } = machine()
    const { asked, rm } = recorder()
    const refusals: Array<[string, string]> = [
      [path.join(appSupport, 'TaskWraith'), 'not_a_dev_instance_profile'],
      [path.join(appSupport, 'TaskWraith Dev'), 'not_a_dev_instance_profile'],
      [path.join(appSupport, 'TaskWraith Dev '), 'not_a_dev_instance_profile'],
      [path.join(appSupport, 'TaskWraith Dev  x'), 'not_a_dev_instance_profile'],
      [path.join(appSupport, 'TaskWraith Dev verify'), 'shared_verify_profile'],
      [appSupport, 'not_in_application_support'],
      [home, 'not_in_application_support'],
      [path.join(tree, 'TaskWraith Dev perf-x'), 'not_in_application_support'],
      [path.join(appSupport, 'nested', 'TaskWraith Dev perf-x'), 'not_in_application_support'],
      [`${appSupport}/TaskWraith Dev perf-x/../TaskWraith`, 'not_a_plain_absolute_path'],
      ['TaskWraith Dev perf-x', 'not_a_plain_absolute_path']
    ]
    for (const [dir, reason] of refusals) {
      expect(matrix.profileDirRefusal(dir, { home })).toBe(reason)
      expect(() => matrix.removeProfileDir(dir, { home, rm })).toThrow(/refusing to remove/)
    }
    expect(asked).toEqual([])
  })
})

describe('every removal the matrix makes', () => {
  // The script launches the app when run, so its source is read.
  it('goes through the guards above', () => {
    const source = readFileSync(path.join(__dirname, 'startupRunMatrix.cjs'), 'utf8')
    expect(source).not.toMatch(/\brmSync\(/)
    expect(source).toContain('if (seedWal) removeAuthorityRoot(authorityRoot)')
    expect(source).toContain("if (kind === 'cold') removeProfileDir(profileDir())")
    expect(source.split('removeProfileDir(profileDir())')).toHaveLength(3)
  })
})

describe('the matrix as a command', () => {
  /**
   * Runs the script with every launch, removal and write refused before it
   * starts, so that a check that fails to stop it cannot do anything.
   */
  function runMatrix(args: string[]) {
    const dir = makeDirectory()
    const stub = path.join(dir, 'no-side-effects.cjs')
    writeFileSync(
      stub,
      [
        "const childProcess = require('child_process')",
        "const fs = require('fs')",
        'const refuse = (what) => () => { throw new Error(`side effect refused: ${what}`) }',
        "childProcess.spawn = refuse('spawn')",
        "for (const name of ['rmSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'openSync']) fs[name] = refuse(name)"
      ].join('\n')
    )
    return spawnSync(
      process.execPath,
      ['-r', stub, path.join(__dirname, 'startupRunMatrix.cjs'), ...args],
      {
        encoding: 'utf8'
      }
    )
  }

  it('refuses before anything runs to seed an authority root it may not wipe', () => {
    const { tree } = machine()
    const root = path.join(tree, 'elsewhere')
    mkdirSync(root)
    const result = runMatrix([
      '--instance-id=perf-guard-check',
      `--authority-root=${root}`,
      `--seed-wal=${path.join(tree, 'seed.jsonl')}`
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`--seed-wal would remove ${root}`)
    expect(result.stderr).toContain('not_in_isolated_homes')
    expect(result.stderr).not.toContain('side effect refused')
    expect(existsSync(root)).toBe(true)
  })

  it('keeps its other argument checks as they were', () => {
    expect(runMatrix([]).stderr.trim()).toBe(
      'Pass --instance-id=<unique id> (not "verify"; see .claude/skills/verify/SKILL.md).'
    )
    expect(runMatrix(['--instance-id=ok-id', '--authority-root=rel']).stderr.trim()).toBe(
      '--authority-root must be an absolute path.'
    )
    expect(runMatrix(['--seed-wal=x']).stderr.trim()).toBe(
      '--seed-wal requires --authority-root (never seed the shared root).'
    )
    expect(runMatrix(['--instance-id=verify']).status).toBe(1)
  })
})
