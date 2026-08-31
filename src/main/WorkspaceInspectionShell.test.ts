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

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

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
  return { workspace, external }
}

describe('WorkspaceInspectionShell', () => {
  it('keeps ordinary brokered workspace discovery and source inspection prompt-free', async () => {
    const { workspace } = await fixture()
    for (const command of [
      'cat README.md',
      'rg -n "permission" src',
      "grep -rIn 'permission' src --include='*.ts'",
      "find src -type f -name '*.ts' -print",
      "jq '.scripts' package.json",
      'git status --short',
      'git diff --stat',
      'wc -l src/main.ts'
    ]) {
      expect(
        workspaceInspectionShellReason(command, { workspacePath: workspace, cwd: workspace }),
        command
      ).not.toBeNull()
    }
  })

  it('rejects external, parent, environment, system-process, and redirect inspection', async () => {
    const { workspace, external } = await fixture()
    for (const command of [
      'cat /etc/passwd',
      `grep -R secret ${external}`,
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
      "jq -n 'include \"../external/module\"; .'",
      "jq -n 'import \"module\" as x; x'",
      'jq --run-tests README.md',
      'cat README.md > /dev/null',
      'git -C /tmp status',
      'rg --glob=/etc/passwd secret .',
      'grep --exclude-from=../external/secret.txt needle .',
      'grep --config:../external/secret.txt needle .',
      'cat @../external/secret.txt',
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
      "jq -f../external/secret.txt README.md",
      "jq -L../external '.' README.md",
      "jq -nL../external '.' README.md",
      'rg permission src | head -n 10',
      'git status --short && git diff --stat',
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

  it('builds a direct executable plan and hardens Git helpers', async () => {
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
      expect.arrayContaining(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_PARAMETERS'])
    )

    const rgPlan = workspaceInspectionExecutionPlan('rg permission src', {
      workspacePath: workspace,
      cwd: workspace
    })
    expect(rgPlan?.unsetEnvironment).toContain('RIPGREP_CONFIG_PATH')
  })

  it('prevents repository-configured fsmonitor execution in a prompt-free Git plan', async () => {
    const { workspace, external } = await fixture()
    const marker = join(external, 'fsmonitor-ran')
    const helper = join(external, 'fsmonitor.sh')
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
  })
})
