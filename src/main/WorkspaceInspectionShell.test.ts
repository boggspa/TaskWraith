import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  isWorkspaceInspectionShellCommand,
  workspaceInspectionExecutionPlan,
  workspaceInspectionShellReason
} from './WorkspaceInspectionShell'

const tempPaths: string[] = []
const originalHome = process.env.HOME

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await Promise.all(tempPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

// @portability-ok The shell resolves trusted executables only from fixed POSIX
// directories; on win32 nothing resolves and every plan fails closed, so the
// prompt-free and execution-plan tests are inherently POSIX.
const isPosixHost = process.platform !== 'win32'

// @portability-ok Presence gate mirroring the shell's trusted-directory
// resolution: CI runners usually lack ripgrep, and a missing rg must produce a
// SKIP, never a silent pass or a false rejection.
const rgAvailable =
  isPosixHost &&
  ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'].some(
    (directory) => existsSync(join(directory, 'rg'))
  )

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-inspection-shell-'))
  tempPaths.push(root)
  const workspace = join(root, 'workspace')
  const external = join(root, 'external')
  await Promise.all([mkdir(join(workspace, 'src'), { recursive: true }), mkdir(external)])
  await writeFile(join(workspace, 'README.md'), '# Workspace')
  await writeFile(join(workspace, 'package.json'), '{"scripts":{"test":"vitest"}}')
  await writeFile(join(workspace, 'src', 'main.ts'), 'const permission = true')
  await writeFile(join(external, 'secret.txt'), 'secret')
  await symlink(external, join(workspace, 'escaped'))
  await symlink(external, join(workspace, 'src', 'escaped'))
  await symlink(external, join(workspace, '-C'))
  await symlink(external, join(workspace, '@escaped'))
  await symlink(external, join(workspace, 'safe=dir'))
  const inwardLink = join(external, 'workspace-link')
  await symlink(workspace, inwardLink)
  return { workspace, external, inwardLink }
}

/**
 * Fixture for the owner's 2026-09-07 read ALLOWLIST: a fake `$HOME` carrying
 * the provider WORKING-STATE subtrees a lane actually needs, the credential and
 * token files that live at the provider ROOTS and must keep their approval
 * card, and the `..` / symlink spellings that must not be able to walk from one
 * to the other.
 */
async function providerStateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-provider-state-'))
  tempPaths.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const gemini = join(home, '.gemini')
  const cli = join(gemini, 'antigravity-cli')
  const agy = join(gemini, 'antigravity')
  const run = '9d1e5b6a-0000-4c2a-9f1b-2b7c4a1d8e30'
  const cliStep = join(cli, 'brain', run, '.system_generated', 'steps', '64')
  const agyScratch = join(agy, 'brain', run, 'scratch')
  await Promise.all([
    mkdir(join(workspace, 'src'), { recursive: true }),
    mkdir(cliStep, { recursive: true }),
    mkdir(join(cli, 'mcp', 'TaskWraith'), { recursive: true }),
    mkdir(join(cli, 'log'), { recursive: true }),
    mkdir(join(cli, 'conversations'), { recursive: true }),
    mkdir(agyScratch, { recursive: true }),
    mkdir(join(root, 'other-repo'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(workspace, 'README.md'), '# Workspace'),
    writeFile(join(workspace, 'src', 'main.ts'), 'const permission = true\nconst other = 1\n'),
    // The three reads that stalled behind an approval card, by their real shapes.
    writeFile(join(cliStep, 'output.txt'), 'step output'),
    writeFile(join(cli, 'mcp', 'TaskWraith', 'ensemble_yield.json'), '{"yield":true}'),
    writeFile(join(agyScratch, 'fix_docs.js'), 'module.exports = {}'),
    writeFile(join(cli, 'log', 'cli-20260907_160115.log'), 'log line'),
    writeFile(join(cli, 'conversations', 'thread.json'), '{}'),
    // Live credentials verified present on the owner's host. Every one sits at
    // a provider ROOT — which is exactly why no root is allowlisted.
    writeFile(join(gemini, 'oauth_creds.json'), '{"refresh_token":"x"}'),
    writeFile(join(gemini, 'google_accounts.json'), '{}'),
    writeFile(join(gemini, 'jetski-standalone-oauth-token'), 'token'),
    writeFile(join(gemini, 'antigravity-oauth-token'), 'token'),
    writeFile(join(cli, 'antigravity-oauth-token'), 'token'),
    writeFile(join(cli, 'settings.json'), '{}'),
    writeFile(join(root, 'other-repo', 'notes.md'), 'another checkout')
  ])
  await Promise.all([
    // Named INSIDE an allowlisted subtree, resolving OUT to a token file. Only
    // resolved-path matching catches this; a raw-token check would pass it.
    symlink(join(cli, 'antigravity-oauth-token'), join(cliStep, 'token.json')),
    // A symlinked DIRECTORY, so the traversal through it carries no `..` at all.
    symlink(gemini, join(cli, 'brain', 'store'))
  ])
  return { workspace, home, gemini, cli, agy, root, cliStep, agyScratch }
}

/**
 * A `$HOME` whose `.gemini` is itself a symlink to a store elsewhere. Each
 * allowlist root is recorded BOTH lexically and via `realpath`, so the resolved
 * read still lands inside one; recording only the lexical root would silently
 * drop the grant here, and recording only the real root would drop it for the
 * ordinary un-symlinked host.
 */
async function symlinkedProviderRootFixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-provider-root-link-'))
  tempPaths.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const store = join(root, 'gemini-store')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(store, 'antigravity-cli', 'brain'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(store, 'antigravity-cli', 'brain', 'output.txt'), 'step output'),
    writeFile(join(store, 'antigravity-cli', 'antigravity-oauth-token'), 'token')
  ])
  await symlink(store, join(home, '.gemini'))
  return { workspace, home, store }
}

describe('WorkspaceInspectionShell', () => {
  it.skipIf(!isPosixHost)(
    'keeps ordinary brokered workspace discovery and source inspection prompt-free',
    async () => {
      const { workspace } = await fixture()
      // `rg -n "permission" src` is covered by the ripgrep-gated test below:
      // GitHub runners do not install ripgrep, and the reason fails closed
      // when the executable cannot be resolved.
      for (const command of [
        'cat README.md',
        "grep -rIn 'permission' src --include='*.ts'",
        "find src -type f -name '*.ts' -print",
        "jq '.scripts' package.json",
        'git status --short',
        'git diff --stat',
        'git diff -- README.md',
        `git -C ${workspace} status --short`,
        'git -C . diff --stat',
        'wc -l src/main.ts'
      ]) {
        expect(
          workspaceInspectionShellReason(command, { workspacePath: workspace, cwd: workspace }),
          command
        ).not.toBeNull()
      }
    }
  )

  // Ripgrep is absent on GitHub runners; skip visibly rather than silently.
  it.skipIf(!rgAvailable)(
    'keeps ripgrep inspection prompt-free and plans its hardened environment when rg is installed',
    async () => {
      const { workspace } = await fixture()
      expect(
        workspaceInspectionShellReason('rg -n "permission" src', {
          workspacePath: workspace,
          cwd: workspace
        })
      ).not.toBeNull()
      const rgPlan = workspaceInspectionExecutionPlan('rg permission src', {
        workspacePath: workspace,
        cwd: workspace
      })
      expect(rgPlan?.unsetEnvironment).toContain('RIPGREP_CONFIG_PATH')
    }
  )

  // The 2026-09-07 read allowlist keeps every entry below carded: an outside
  // path is prompt-free only inside `PROMPT_FREE_OUTSIDE_READ_ROOTS`, and none
  // of these resolve there. Lifting the single-segment cap moved exactly two
  // former entries out of this list — `rg permission src | head -n 10` and
  // `git status --short && git diff --stat` — into the pipeline tests below;
  // nothing else was removed.
  it('rejects external, parent, environment, system-process, and redirect inspection', async () => {
    const { workspace, external, inwardLink } = await fixture()
    for (const command of [
      'cat /etc/passwd',
      `grep -R secret ${external}`,
      `cat ${inwardLink}/README.md`,
      `git -C ${inwardLink} status --short`,
      'find / -maxdepth 2 -type f',
      'cat ../external/secret.txt',
      'printenv',
      'env',
      'ps',
      "jq -n 'env'",
      "jq -n 'env.PATH'",
      "jq -n '$ENV'",
      "jq -n 'env | .'",
      "jq -n '[env]'",
      "jq -n 'null | env'",
      'jq -n \'include "../external/module"; .\'',
      'jq -n \'import "module" as x; x\'',
      'jq --run-tests README.md',
      'cat README.md > /dev/null',
      'git -C /tmp status',
      'git -C escaped status',
      'git -C . -C src status',
      'git -C -C status --short',
      `git -C ${workspace} reset --hard`,
      'rg --glob=/etc/passwd secret .',
      'grep --exclude-from=../external/secret.txt needle .',
      'grep --config:../external/secret.txt needle .',
      'cat @../external/secret.txt',
      'cat @escaped/secret.txt',
      'cat safe=dir/secret.txt',
      'cat -- -C/secret.txt',
      'grep -f -C needle src',
      'grep --exclude-from -C needle src',
      "jq --rawfile name -C '.'",
      'git -C @escaped status --short',
      'cat escaped*',
      "cat escaped*''",
      "cat ''escaped*",
      'cat =cat',
      'grep needle =grep',
      'cat src/^main.ts/secret.txt',
      'grep needle src/escaped*',
      "grep needle src/escaped*''",
      'grep -RIn needle src',
      'grep --dereference-r needle src',
      'grep --de needle src',
      'rg --follow needle src',
      'rg -L needle src',
      'rg -nL needle src',
      'rg -z needle src',
      'rg -nz needle src',
      'rg --search-zip needle src',
      'rg --search-z needle src',
      'find -L src -type f',
      'find -follow src -type f',
      'find -files0-from=README.md -type f',
      'tree -l src',
      'tree -R src',
      'ls --derefer -R src',
      'ls --de -R src',
      'grep -f../external/secret.txt needle src',
      'rg -f../external/secret.txt needle src',
      'rg -nf../external/secret.txt needle src',
      'jq -f../external/secret.txt README.md',
      "jq -L../external '.' README.md",
      "jq -nL../external '.' README.md",
      'date -r/etc/passwd',
      'tail -f README.md',
      'tail -nF README.md',
      'tail --follow=name --retry README.md',
      'tail --fol=name README.md',
      'tail --f=name README.md',
      'tail --ret README.md',
      'tail --r README.md',
      'wc --files0-from=README.md',
      'wc --f=README.md'
    ]) {
      expect(
        isWorkspaceInspectionShellCommand(command, { workspacePath: workspace, cwd: workspace }),
        command
      ).toBe(false)
    }
  })

  it('rejects workspace symlink escapes and an external cwd', async () => {
    const { workspace, external } = await fixture()
    expect(
      isWorkspaceInspectionShellCommand('cat escaped/secret.txt', {
        workspacePath: workspace,
        cwd: workspace
      })
    ).toBe(false)
    expect(
      isWorkspaceInspectionShellCommand("find escaped -name '*.txt' -print", {
        workspacePath: workspace,
        cwd: workspace
      })
    ).toBe(false)
    expect(
      isWorkspaceInspectionShellCommand('cat secret.txt', {
        workspacePath: workspace,
        cwd: external
      })
    ).toBe(false)
  })

  // Owner decision 2026-09-07 — a command the read-only classifier has already
  // proven non-mutating may point outside the workspace, but ONLY inside the
  // allowlisted provider working-state subtrees. WHICH commands are read-only
  // is unchanged; only WHERE they may point.
  describe('allowlisted provider-state reads (owner decision 2026-09-07)', () => {
    it.skipIf(!isPosixHost)('still cards a provider LOG read', async () => {
      // `log` is deliberately not allowlisted. Verified 2026-09-07 that agy CLI
      // logs carry the signed-in account address and auth state, and no observed
      // lane stall reads one — so the grant would cost PII exposure for nothing.
      const { workspace, home, cli } = await providerStateFixture()
      process.env.HOME = home
      expect(
        workspaceInspectionShellReason(`cat ${join(cli, 'log', 'cli-20260907_160115.log')}`, {
          workspacePath: workspace,
          cwd: workspace
        })
      ).toBeNull()
    })

    it.skipIf(!isPosixHost)(
      'keeps the three stalled provider working-state reads prompt-free',
      async () => {
        const { workspace, home, cli, agyScratch, cliStep } = await providerStateFixture()
        process.env.HOME = home
        for (const command of [
          // The exact reads that were costing a live approval card.
          `cat ${join(cliStep, 'output.txt')}`,
          `cat ${join(cli, 'mcp', 'TaskWraith', 'ensemble_yield.json')}`,
          `cat ${join(agyScratch, 'fix_docs.js')}`,
          // The remaining working-state categories the allowlist covers.
          `cat ${join(cli, 'conversations', 'thread.json')}`,
          // Every read-only head reaches them, not just `cat`.
          `head -n 5 ${join(cliStep, 'output.txt')}`,
          `tail -n 5 ${join(cliStep, 'output.txt')}`,
          `wc -l ${join(cliStep, 'output.txt')}`,
          `stat ${join(cliStep, 'output.txt')}`,
          `grep needle ${join(cliStep, 'output.txt')}`,
          `sed -n '1,5p' ${join(cliStep, 'output.txt')}`
        ]) {
          expect(
            workspaceInspectionShellReason(command, { workspacePath: workspace, cwd: workspace }),
            command
          ).not.toBeNull()
        }
        // The approval gate and the pre-spawn revalidation in index.ts derive
        // from the same predicate, so a single-segment read must also produce a
        // typed plan or execution would throw after the card was skipped.
        expect(
          workspaceInspectionExecutionPlan(`cat ${join(cliStep, 'output.txt')}`, {
            workspacePath: workspace,
            cwd: workspace
          })?.argv
        ).toEqual([join(cliStep, 'output.txt')])
      }
    )

    it.skipIf(!isPosixHost)(
      'still requires approval for every credential and token file at a provider root',
      async () => {
        const { workspace, home, gemini, cli } = await providerStateFixture()
        process.env.HOME = home
        for (const command of [
          `cat ${join(gemini, 'oauth_creds.json')}`,
          `cat ${join(gemini, 'google_accounts.json')}`,
          `cat ${join(gemini, 'jetski-standalone-oauth-token')}`,
          `cat ${join(gemini, 'antigravity-oauth-token')}`,
          `cat ${join(cli, 'antigravity-oauth-token')}`,
          // The provider root is not allowlisted at all, so ordinary files
          // sitting beside the tokens stay carded too.
          `cat ${join(cli, 'settings.json')}`,
          `grep secret ${join(gemini, 'oauth_creds.json')}`
        ]) {
          expect(
            isWorkspaceInspectionShellCommand(command, {
              workspacePath: workspace,
              cwd: workspace
            }),
            command
          ).toBe(false)
        }
      }
    )

    it.skipIf(!isPosixHost)(
      'still requires approval for ordinary out-of-workspace reads',
      async () => {
        const { workspace, home, cli, root } = await providerStateFixture()
        process.env.HOME = home
        for (const command of [
          'cat /etc/passwd',
          'rg --glob=/etc/passwd secret .',
          `cat ${join(root, 'other-repo', 'notes.md')}`,
          `grep needle ${join(root, 'other-repo', 'notes.md')}`,
          // A sibling of an allowlisted subtree is not itself allowlisted.
          `cat ${join(cli, 'history.jsonl')}`
        ]) {
          expect(
            isWorkspaceInspectionShellCommand(command, {
              workspacePath: workspace,
              cwd: workspace
            }),
            command
          ).toBe(false)
        }
      }
    )

    it.skipIf(!isPosixHost)(
      'still requires approval when `..` or a symlink leaves an allowlisted subtree',
      async () => {
        const { workspace, home, agy, cli, cliStep } = await providerStateFixture()
        process.env.HOME = home
        for (const command of [
          // `..` is rejected before resolution, exactly as inside the workspace,
          // because this layer cannot resolve it with confidence — even when the
          // spelling would have landed back inside the allowlist.
          `cat ${join(cli, 'brain')}/../antigravity-oauth-token`,
          `cat ${join(cli, 'brain')}/../brain/store/oauth_creds.json`,
          `cat ${join(agy, 'brain')}/../../oauth_creds.json`,
          // Symlink spellings carry no `..` at all, so ONLY resolved-path
          // matching catches them. Both are NAMED inside an allowlisted subtree.
          `cat ${join(cliStep, 'token.json')}`,
          `cat ${join(cli, 'brain', 'store', 'oauth_creds.json')}`,
          `cat ${join(cli, 'brain', 'store', 'antigravity-cli', 'antigravity-oauth-token')}`,
          // …and the same spelling aimed at a non-credential path that is
          // simply not allowlisted.
          `cat ${join(cli, 'brain', 'store', 'antigravity-cli', 'settings.json')}`
        ]) {
          expect(
            isWorkspaceInspectionShellCommand(command, {
              workspacePath: workspace,
              cwd: workspace
            }),
            command
          ).toBe(false)
        }
      }
    )

    it.skipIf(!isPosixHost)(
      'records each allowlist root lexically and via realpath, so a symlinked provider root resolves',
      async () => {
        const { workspace, home, store } = await symlinkedProviderRootFixture()
        process.env.HOME = home
        for (const command of [
          // Spelled through the symlinked root: only the realpath-recorded root
          // can recognise where this resolves.
          `cat ${join(home, '.gemini', 'antigravity-cli', 'brain', 'output.txt')}`,
          // Spelled through the real store: the lexical root cannot see this one.
          `cat ${join(store, 'antigravity-cli', 'brain', 'output.txt')}`
        ]) {
          expect(
            workspaceInspectionShellReason(command, { workspacePath: workspace, cwd: workspace }),
            command
          ).not.toBeNull()
        }
        // The token beside it is still outside every allowlisted subtree.
        for (const command of [
          `cat ${join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')}`,
          `cat ${join(store, 'antigravity-cli', 'antigravity-oauth-token')}`
        ]) {
          expect(
            isWorkspaceInspectionShellCommand(command, {
              workspacePath: workspace,
              cwd: workspace
            }),
            command
          ).toBe(false)
        }
      }
    )

    it.skipIf(!isPosixHost)(
      'fails closed on paths and homes it cannot resolve, and on directory operands',
      async () => {
        const { workspace, home, cli, cliStep } = await providerStateFixture()
        process.env.HOME = home
        for (const command of [
          `cat ${join(cliStep, 'missing.txt')}`,
          `cat ${join(cli, 'brain', 'no-such-run', 'output.txt')}`,
          // A directory can be walked recursively by grep/rg/find, so admitting
          // one would hand over a whole subtree instead of one file.
          `ls ${cliStep}`,
          `grep needle ${join(cli, 'brain')}`,
          `git -C ${join(cli, 'brain')} status --short`
        ]) {
          expect(
            isWorkspaceInspectionShellCommand(command, {
              workspacePath: workspace,
              cwd: workspace
            }),
            command
          ).toBe(false)
        }
        // An unresolvable home means the allowlist cannot be located at all, so
        // the whole outside allowance closes rather than matching nothing by
        // accident.
        process.env.HOME = join(home, 'no-such-home')
        expect(
          isWorkspaceInspectionShellCommand(`cat ${join(cliStep, 'output.txt')}`, {
            workspacePath: workspace,
            cwd: workspace
          })
        ).toBe(false)
      }
    )

    it.skipIf(!isPosixHost)(
      'leaves mutating provider-state commands and in-workspace reads untouched',
      async () => {
        const { workspace, home, cliStep } = await providerStateFixture()
        process.env.HOME = home
        const output = join(cliStep, 'output.txt')
        for (const command of [
          `rm -rf ${cliStep}`,
          `sed -i s/a/b/ ${output}`,
          `cp ${output} ${join(cliStep, 'copy.txt')}`,
          `touch ${join(cliStep, 'new.txt')}`,
          `chmod 777 ${output}`,
          `cat ${output} > ${join(cliStep, 'copy.txt')}`,
          `cat ${output} | tee ${join(cliStep, 'copy.txt')}`
        ]) {
          expect(
            isWorkspaceInspectionShellCommand(command, {
              workspacePath: workspace,
              cwd: workspace
            }),
            command
          ).toBe(false)
        }
        for (const command of ['cat README.md', `cat ${join(workspace, 'README.md')}`]) {
          expect(
            workspaceInspectionShellReason(command, { workspacePath: workspace, cwd: workspace }),
            command
          ).not.toBeNull()
        }
        // A workspace binding is still mandatory: no workspace, no fast path.
        expect(
          workspaceInspectionShellReason(`cat ${output}`, { workspacePath: null, cwd: cliStep })
        ).toBeNull()
      }
    )
  })

  // The single-segment cap is gone (2026-09-07): layer 1 already proves EVERY
  // `|` segment read-only, and the operand walk re-runs the full head /
  // trusted-executable / flag / path checks once per segment. A pipeline is
  // prompt-free only when every one of its parts is.
  describe('multi-segment pipelines', () => {
    it.skipIf(!isPosixHost)('keeps a fully proven in-workspace pipeline prompt-free', async () => {
      const { workspace } = await fixture()
      for (const command of [
        // The two shapes that were costing a live approval card.
        "cat -n src/main.ts | sed -n '1,2p'",
        'cat -n src/main.ts | grep -n "const permission"',
        'cat README.md | head -n 3',
        'cat README.md | head -n 3 | wc -l',
        'git status --short && git diff --stat',
        'git status --short; git diff --stat'
      ]) {
        expect(
          workspaceInspectionShellReason(command, { workspacePath: workspace, cwd: workspace }),
          command
        ).not.toBeNull()
      }
    })

    it.skipIf(!rgAvailable)('keeps a proven ripgrep pipeline prompt-free', async () => {
      const { workspace } = await fixture()
      expect(
        workspaceInspectionShellReason('rg permission src | head -n 10', {
          workspacePath: workspace,
          cwd: workspace
        })
      ).not.toBeNull()
    })

    it.skipIf(!isPosixHost)(
      'has no typed single-argv plan for a pipeline, so the gate never promises one',
      async () => {
        const { workspace } = await fixture()
        const command = 'cat README.md | head -n 3'
        expect(
          workspaceInspectionShellReason(command, { workspacePath: workspace, cwd: workspace })
        ).not.toBeNull()
        // No single executable/argv can describe a pipeline. `null` here means
        // "run it the ordinary brokered way", never "not allowed" — see the
        // direct-plan gate in ApprovalOrchestration.ts.
        expect(
          workspaceInspectionExecutionPlan(command, { workspacePath: workspace, cwd: workspace })
        ).toBeNull()
      }
    )

    it.skipIf(!isPosixHost)('requires EVERY segment to pass on its own', async () => {
      const { workspace, external } = await fixture()
      for (const command of [
        // Segment 2 escapes the workspace and is not allowlisted.
        `cat README.md | cat ${join(external, 'secret.txt')}`,
        'cat README.md | cat /etc/passwd',
        'cat README.md | grep needle ../external/secret.txt',
        'cat README.md | cat escaped/secret.txt',
        // Segment 2 is a system-confidential head. Layer 1 proves bare `env`
        // non-mutating, so only this layer's per-segment head check rejects it.
        'cat README.md | env',
        // Segment 2 follows symlinks out of the workspace.
        'cat README.md | grep -RIn needle src',
        // Segment 2 mutates.
        'cat README.md | tee copy.txt',
        'cat README.md | rm -rf src',
        // Still rejected outright by `commandSegments`, unchanged by the cap lift.
        'cat README.md | head -n 3 > copy.txt',
        'cat README.md || cat src/main.ts',
        'cat README.md |',
        '| cat README.md',
        '|',
        ';'
      ]) {
        expect(
          isWorkspaceInspectionShellCommand(command, { workspacePath: workspace, cwd: workspace }),
          command
        ).toBe(false)
      }
    })

    it.skipIf(!isPosixHost)('applies the outside-read allowlist per segment', async () => {
      const { workspace, home, cli, cliStep } = await providerStateFixture()
      process.env.HOME = home
      expect(
        workspaceInspectionShellReason(`cat ${join(cliStep, 'output.txt')} | head -n 1`, {
          workspacePath: workspace,
          cwd: workspace
        })
      ).not.toBeNull()
      expect(
        isWorkspaceInspectionShellCommand(
          `cat ${join(cliStep, 'output.txt')} | cat ${join(cli, 'antigravity-oauth-token')}`,
          { workspacePath: workspace, cwd: workspace }
        )
      ).toBe(false)
    })
  })

  it.skipIf(!isPosixHost)('builds a direct executable plan and hardens Git helpers', async () => {
    const { workspace } = await fixture()
    const catPlan = workspaceInspectionExecutionPlan('cat README.md', {
      workspacePath: workspace,
      cwd: workspace
    })
    expect(catPlan).toMatchObject({ argv: ['README.md'], cwd: await realpath(workspace) })
    expect(catPlan?.executableRealPath).toMatch(/\/cat$/)
    expect(catPlan?.executableRealPath).not.toContain(workspace)

    const gitPlan = workspaceInspectionExecutionPlan('git diff --stat', {
      workspacePath: workspace,
      cwd: workspace
    })
    expect(gitPlan?.argv).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--stat'])
    expect(gitPlan?.environment).toMatchObject({
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'diff.external',
      GIT_CONFIG_VALUE_1: '/usr/bin/false'
    })
    expect(gitPlan?.unsetEnvironment).toEqual(
      expect.arrayContaining([
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_EXTERNAL_DIFF',
        'GIT_CONFIG_PARAMETERS'
      ])
    )

    // The rg plan's hardened environment is asserted by the ripgrep-gated test
    // above, because GitHub runners do not install ripgrep.

    const gitCPlan = workspaceInspectionExecutionPlan(`git -C ${workspace} status --short`, {
      workspacePath: workspace,
      cwd: workspace
    })
    expect(gitCPlan?.argv).toEqual(['-C', workspace, 'status', '--short'])
  })

  it.skipIf(!isPosixHost)(
    'prevents repository-configured fsmonitor execution in a prompt-free Git plan',
    async () => {
      const { workspace, external } = await fixture()
      const marker = join(external, 'fsmonitor-ran')
      const helper = join(external, 'fsmonitor.sh')
      // @portability-ok: helper content only — the test asserts git never executes it
      await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`)
      await chmod(helper, 0o700)
      const git = workspaceInspectionExecutionPlan('git status --short', {
        workspacePath: workspace,
        cwd: workspace
      })
      if (!git) throw new Error('Expected a trusted Git inspection plan.')
      expect(spawnSync(git.executableRealPath, ['init'], { cwd: workspace }).status).toBe(0)
      expect(
        spawnSync(git.executableRealPath, ['config', 'core.fsmonitor', helper], { cwd: workspace })
          .status
      ).toBe(0)
      const env = { ...process.env }
      for (const key of git.unsetEnvironment || []) delete env[key]
      Object.assign(env, git.environment || {})
      expect(spawnSync(git.executableRealPath, git.argv, { cwd: git.cwd, env }).status).toBe(0)
      expect(existsSync(marker)).toBe(false)
    }
  )
})
