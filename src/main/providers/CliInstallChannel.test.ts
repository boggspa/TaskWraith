import { describe, expect, it } from 'vitest'
import {
  cliUpgradeCommand,
  detectCliInstallChannel,
  unknownInstallChannelMessage
} from './CliInstallChannel'

describe('detectCliInstallChannel', () => {
  it('classifies the two real-world Codex installs seen in the field', () => {
    // Both put their symlink in the SAME bin directory, which is why the
    // channel cannot be guessed from the link — only from the realpath.
    expect(
      detectCliInstallChannel('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')
    ).toBe('npm')
    expect(
      detectCliInstallChannel('/opt/homebrew/Caskroom/codex/0.144.0/codex-aarch64-apple-darwin')
    ).toBe('homebrew-cask')
  })

  it('does not mistake an npm prefix inside Homebrew for a Homebrew install', () => {
    // The trap: npm's global prefix commonly lives under /opt/homebrew, so any
    // "is it under the Homebrew prefix?" test calls an npm install Homebrew and
    // emits `brew upgrade` for a package brew has never heard of.
    expect(
      detectCliInstallChannel('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')
    ).toBe('npm')
  })

  it('classifies a Homebrew formula separately from a cask', () => {
    // Different upgrade command: `brew upgrade x` vs `brew upgrade --cask x`.
    expect(detectCliInstallChannel('/opt/homebrew/Cellar/codex/0.144.0/bin/codex')).toBe(
      'homebrew-formula'
    )
  })

  it('returns unknown rather than guessing', () => {
    expect(detectCliInstallChannel('/usr/local/bin/codex')).toBe('unknown')
    expect(detectCliInstallChannel('')).toBe('unknown')
    expect(detectCliInstallChannel(null)).toBe('unknown')
  })

  it('handles Windows-style separators', () => {
    expect(
      detectCliInstallChannel('C:\\Users\\x\\AppData\\npm\\node_modules\\@openai\\codex')
    ).toBe('npm')
  })
})

describe('cliUpgradeCommand', () => {
  it('emits the command for the channel that owns the binary', () => {
    expect(cliUpgradeCommand({ channel: 'npm', npmPackage: '@openai/codex' })).toEqual([
      'npm',
      'install',
      '-g',
      '@openai/codex@latest'
    ])
    expect(
      cliUpgradeCommand({
        channel: 'homebrew-cask',
        npmPackage: '@openai/codex',
        brewToken: 'codex'
      })
    ).toEqual(['brew', 'upgrade', '--cask', 'codex'])
    expect(
      cliUpgradeCommand({
        channel: 'homebrew-formula',
        npmPackage: '@openai/codex',
        brewToken: 'codex'
      })
    ).toEqual(['brew', 'upgrade', 'codex'])
  })

  it('refuses rather than guessing for an unknown channel', () => {
    // The whole point: an upgrade that targets a DIFFERENT copy reports success
    // and changes nothing, which is how "upgraded three times" still failed a
    // version-gated model check.
    expect(cliUpgradeCommand({ channel: 'unknown', npmPackage: '@openai/codex' })).toBeNull()
  })

  it('refuses a Homebrew channel with no token to upgrade', () => {
    expect(cliUpgradeCommand({ channel: 'homebrew-cask', npmPackage: '@openai/codex' })).toBeNull()
  })
})

describe('unknownInstallChannelMessage', () => {
  it('names the binary we actually run', () => {
    const message = unknownInstallChannelMessage('Codex', '/usr/local/bin/codex')
    expect(message).toContain('/usr/local/bin/codex')
    expect(message).toMatch(/whichever tool installed it/i)
  })
})
