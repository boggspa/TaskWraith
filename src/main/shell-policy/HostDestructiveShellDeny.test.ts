import { describe, expect, it } from 'vitest'
import { isHostDestructiveShellCommand } from './HostDestructiveShellDeny'

describe('isHostDestructiveShellCommand (deny-wall — never spawns)', () => {
  it('denies the screenshot host-destroy patterns', () => {
    for (const command of [
      'rm -rf /',
      'rm -rf /*',
      'rm -rf ~',
      'rm -rf ~/',
      'rm -rf ~*',
      'sudo rm -rf /',
      'sudo rm -rf *',
      'diskutil eraseDisk',
      'diskutil eraseVolume disk2',
      'diskutil apfs deleteContainer disk3',
      'diskutil apfs deleteVolume disk3s1',
      'dd if=/dev/zero of=/dev/disk0',
      'dd of=/dev/rdisk1 if=image.img',
      'mkfs',
      'mkfs.ext4 /dev/disk0s1',
      'shutdown now',
      'shutdown -h now',
      'reboot',
      'reboot -h now',
      'halt',
      'halt -p'
    ]) {
      expect(isHostDestructiveShellCommand(command), command).toBe(true)
    }
  })

  it('denies those patterns when chained with otherwise-safe commands', () => {
    for (const command of [
      'ls && rm -rf /',
      'true; shutdown now',
      'pwd; reboot',
      'echo ready && halt',
      'cat package.json | dd of=/dev/sda',
      'npm test && diskutil eraseDisk'
    ]) {
      expect(isHostDestructiveShellCommand(command), command).toBe(true)
    }
  })

  it('denies wrapped host-destroy (sudo, env, bash -c)', () => {
    for (const command of [
      'sudo -n rm -rf /',
      "bash -c 'rm -rf /'",
      'sh -c "shutdown now"',
      'env FOO=1 reboot'
    ]) {
      expect(isHostDestructiveShellCommand(command), command).toBe(true)
    }
  })

  it('allows ordinary developer commands that agents actually need', () => {
    for (const command of [
      'ls -la src',
      'git status --short',
      'git diff',
      'npm test',
      'npm run build',
      'pnpm exec vitest run src/main/foo.test.ts',
      'npx tsc --noEmit',
      'python3 -m pytest',
      'mkdir -p tmp/out',
      'cp README.md /tmp/readme-copy.md',
      'rm -rf dist',
      'rm -rf ./build',
      'echo halt',
      'git commit -m "do not shutdown the feature"',
      'ls && npm test',
      'curl -fsSL https://example.com -o pkg.tgz'
    ]) {
      expect(isHostDestructiveShellCommand(command), command).toBe(false)
    }
  })

  it('fails closed to deny on unparsed chains that still name a destroy head', () => {
    expect(isHostDestructiveShellCommand('$(reboot)')).toBe(true)
    expect(isHostDestructiveShellCommand('`shutdown now`')).toBe(true)
  })

  it('does not classify non-strings as destructive', () => {
    expect(isHostDestructiveShellCommand(undefined)).toBe(false)
    expect(isHostDestructiveShellCommand(['rm', '-rf', '/'])).toBe(false)
    expect(isHostDestructiveShellCommand('')).toBe(false)
  })
})
