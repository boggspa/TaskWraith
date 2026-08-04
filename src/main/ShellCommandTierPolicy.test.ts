import { describe, expect, it } from 'vitest'
import {
  deletionTargetsProvablyInsideWorkspace,
  isCatastrophicDeletionShellCommand,
  isInspectionShellCommand,
  isRemoteEgressShellCommand,
  isSystemProcessMutationShellCommand,
  shellCommandTierHold
} from './ShellCommandTierPolicy'

describe('isInspectionShellCommand (allow polarity — fails closed)', () => {
  it('accepts plain read-only inspection commands', () => {
    for (const cmd of [
      'ls -la src',
      'pwd',
      'cat package.json',
      'head -n 40 src/main/index.ts',
      'tail -f logs.txt',
      'wc -l src/main/index.ts',
      'grep -rn TODO src',
      'rg -n neverAutoAllow src/main',
      'diff a.txt b.txt',
      'stat -f %z package.json',
      'du -sh node_modules',
      'which node',
      'uname -a',
      'echo done',
      'env',
      '/bin/ls -la',
      '/usr/bin/wc -l notes.md'
    ]) {
      expect(isInspectionShellCommand(cmd), cmd).toBe(true)
    }
  })

  it('rejects execution, mutation, and composition vectors', () => {
    for (const cmd of [
      'rg --pre cat -n secrets src', // rg preprocessor = RCE
      'rg --pre=cat -n secrets src',
      'env DEBUG=1 node evil.js', // env-with-args executes
      'find . -name x', // find excluded wholesale (-delete/-exec family)
      'sed -i s/a/b/ file', // charset would reject slashes? no — reject head
      'awk BEGIN{}', // charset rejects braces anyway; head also unknown
      'cat secrets > /tmp/out', // redirect (charset)
      'ls; rm -rf /', // separator (charset)
      'cat `whoami`', // backtick (charset)
      'cat $(pwd)/x', // subshell (charset)
      "grep 'a b' file", // quotes (charset)
      'cat ~/secrets', // tilde expansion
      'ls *.md', // glob (charset)
      '../bin/ls x', // path head outside standard bins
      './ls x',
      'node -e 1',
      'python3 -c print(1)',
      'curl https://example.com', // network is the egress hold's territory
      'xargs rm',
      ''
    ]) {
      expect(isInspectionShellCommand(cmd), cmd).toBe(false)
    }
  })

  it('rejects non-strings and oversized commands', () => {
    expect(isInspectionShellCommand(undefined)).toBe(false)
    expect(isInspectionShellCommand(['ls'])).toBe(false)
    expect(isInspectionShellCommand('ls ' + 'a'.repeat(500))).toBe(false)
  })
})

describe('isCatastrophicDeletionShellCommand (hold polarity)', () => {
  it('matches recursive rm, destructive find, and shred', () => {
    for (const cmd of [
      'rm -rf node_modules',
      'rm -fr build',
      'rm -r src',
      'rm -Rf x',
      'rm --recursive x',
      'rm -rfv --  dir',
      '/bin/rm -rf /tmp/x',
      'find . -name x -delete',
      'find . -exec rm {} +',
      'find . -execdir rm {} +',
      'shred secrets.txt'
    ]) {
      expect(isCatastrophicDeletionShellCommand(cmd), cmd).toBe(true)
    }
  })

  it('does not match plain deletes, reads, or unparseable input', () => {
    for (const cmd of ['rm file.txt', 'rm -f file.txt', 'rmdir empty', 'ls -r', 'find . -name x', '']) {
      expect(isCatastrophicDeletionShellCommand(cmd), cmd).toBe(false)
    }
  })
})

describe('deletionTargetsProvablyInsideWorkspace (allow polarity — fails closed)', () => {
  const ws = '/repo'
  it('proves relative and workspace-absolute targets', () => {
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf build', ws)).toBe(true)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf ./build dist', ws)).toBe(true)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf /repo/node_modules', ws)).toBe(true)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf -- build', ws)).toBe(true)
  })

  it('fails closed on escapes, expansion, globs, and missing context', () => {
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf ../other', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf build/../../other', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf /tmp/x', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf /repository-sibling', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf ~/x', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf *', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf $HOME', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf', ws)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('rm -rf build', undefined)).toBe(false)
    expect(deletionTargetsProvablyInsideWorkspace('find . -delete', ws)).toBe(false)
  })
})

describe('isRemoteEgressShellCommand (hold polarity)', () => {
  it('matches ssh-family, raw network tools, and remote rsync', () => {
    for (const cmd of [
      'ssh host uptime',
      'autossh -M 0 host',
      'ssh-copy-id host',
      'scp file host:/tmp',
      'sftp host',
      'mosh host',
      'telnet host 80',
      'nc host 4444',
      'ncat -l 8080',
      'netcat host 22',
      'curl https://example.com',
      'wget https://example.com/x',
      'ftp host',
      'rsync -av dir host:/backup',
      'rsync -av dir user@host:/backup',
      'rsync -av rsync://host/module dir',
      'rsync -e ssh dir dest',
      '/usr/bin/ssh host'
    ]) {
      expect(isRemoteEgressShellCommand(cmd), cmd).toBe(true)
    }
  })

  it('does not match local commands or local rsync', () => {
    for (const cmd of ['ls -la', 'rsync -av src/ dest/', 'git push origin main', 'echo ssh', '']) {
      expect(isRemoteEgressShellCommand(cmd), cmd).toBe(false)
    }
  })
})

describe('isSystemProcessMutationShellCommand (hold polarity)', () => {
  it('matches the kill family and service managers only', () => {
    for (const cmd of ['kill -9 123', 'pkill node', 'killall TaskWraith', 'launchctl unload x', 'systemctl stop y']) {
      expect(isSystemProcessMutationShellCommand(cmd), cmd).toBe(true)
    }
    for (const cmd of ['ps aux', 'top', 'ls', '']) {
      expect(isSystemProcessMutationShellCommand(cmd), cmd).toBe(false)
    }
  })
})

describe('shellCommandTierHold (the gate fold)', () => {
  const hold = (presetId: string | undefined, shellCommand: unknown, workspacePath = '/repo') =>
    shellCommandTierHold({ presetId, service: 'shellCommands', shellCommand, workspacePath })

  it('holds remote egress at every tier', () => {
    for (const presetId of ['read_only', 'plan', 'default', 'workspace_write', 'full_access', undefined]) {
      expect(hold(presetId, 'ssh host uptime'), String(presetId)).toBe(true)
      expect(hold(presetId, 'curl https://example.com'), String(presetId)).toBe(true)
    }
  })

  it('holds catastrophic deletion everywhere except provably-in-workspace Full Access', () => {
    for (const presetId of ['default', 'workspace_write', 'read_only', undefined]) {
      expect(hold(presetId, 'rm -rf build'), String(presetId)).toBe(true)
    }
    // Full Access: "always approve in workspace" — provable targets auto.
    expect(hold('full_access', 'rm -rf build')).toBe(false)
    expect(hold('full_access', 'rm -rf /repo/dist')).toBe(false)
    // …but any escape, expansion, or missing proof still asks.
    expect(hold('full_access', 'rm -rf /tmp/x')).toBe(true)
    expect(hold('full_access', 'rm -rf ../sibling')).toBe(true)
    expect(hold('full_access', 'rm -rf ~/x')).toBe(true)
    expect(
      shellCommandTierHold({
        presetId: 'full_access',
        service: 'shellCommands',
        shellCommand: 'rm -rf build',
        workspacePath: undefined
      })
    ).toBe(true)
  })

  it('holds system-process mutation at Full WS Access only', () => {
    expect(hold('workspace_write', 'pkill node')).toBe(true)
    expect(hold('full_access', 'pkill node')).toBe(false)
    expect(hold('default', 'pkill node')).toBe(false)
  })

  it('never holds what it cannot parse, other services, or ordinary commands', () => {
    expect(hold('workspace_write', { weird: true })).toBe(false)
    expect(hold('workspace_write', 'npm run build')).toBe(false)
    expect(hold('workspace_write', 'rm file.txt')).toBe(false)
    expect(
      shellCommandTierHold({
        presetId: 'workspace_write',
        service: 'fileChanges',
        shellCommand: 'rm -rf x',
        workspacePath: '/repo'
      })
    ).toBe(false)
  })

  it('normalizes argv and sh -c wrappers like the gates do', () => {
    expect(hold('workspace_write', ['rm', '-rf', 'build'])).toBe(true)
    expect(hold('workspace_write', ['/bin/sh', '-c', 'ssh host uptime'])).toBe(true)
  })
})
