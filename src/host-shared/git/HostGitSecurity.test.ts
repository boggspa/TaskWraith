import { describe, expect, it } from 'vitest'

import {
  HOST_GIT_SAFE_CONFIG_OVERRIDES,
  HostGitRefusedError,
  assertReadOnlyHostGitArgs,
  hardenedHostGitArgs,
  hostGitEnvironment,
  isGitExecutable,
  shouldScrubHostGitEnvKey
} from './HostGitSecurity'

describe('config hardening', () => {
  it.each([
    'core.fsmonitor=false',
    'diff.external=',
    'credential.helper=',
    'credential.interactive=never',
    'core.sshCommand=ssh',
    'protocol.ext.allow=never',
    'commit.gpgSign=false',
    'tag.gpgSign=false',
    'push.gpgSign=false'
  ])('pins %s — each one closes an execution or credential path', (override) => {
    expect(HOST_GIT_SAFE_CONFIG_OVERRIDES).toContain(override)
  })

  it('disables hooks and the attributes file', () => {
    const joined = HOST_GIT_SAFE_CONFIG_OVERRIDES.join(' ')
    expect(joined).toMatch(/core\.hooksPath=/)
    expect(joined).toMatch(/core\.attributesFile=/)
  })

  it('uses the literal /dev/null for include.path on EVERY platform', () => {
    // NOT DISABLED_GIT_PATH: git refuses relative command-line config includes,
    // and NUL is relative under Windows rules. Git for Windows maps the literal
    // '/dev/null' to the NUL device, so this one spelling is absolute
    // everywhere. This already caused a Windows regression once.
    expect(HOST_GIT_SAFE_CONFIG_OVERRIDES).toContain('include.path=/dev/null')
    expect(HOST_GIT_SAFE_CONFIG_OVERRIDES).not.toContain('include.path=NUL')
  })

  it('prepends every override ahead of the caller argv', () => {
    const args = hardenedHostGitArgs(['status', '--porcelain=v1'])
    expect(args.slice(0, HOST_GIT_SAFE_CONFIG_OVERRIDES.length)).toEqual([
      ...HOST_GIT_SAFE_CONFIG_OVERRIDES
    ])
    expect(args.slice(-2)).toEqual(['status', '--porcelain=v1'])
  })
})

describe('environment scrubbing', () => {
  it.each([
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'NPM_TOKEN',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'MATCH_PASSWORD',
    'CSC_KEY_PASSWORD',
    'ASC_PRIVATE_KEY',
    'CARGO_REGISTRY_TOKEN',
    'SSH_ASKPASS',
    'SSH_ASKPASS_REQUIRE'
  ])('scrubs %s', (key) => {
    expect(shouldScrubHostGitEnvKey(key)).toBe(true)
  })

  it('scrubs the whole GIT_ namespace, which can re-target the read', () => {
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_SSH_COMMAND']) {
      expect(shouldScrubHostGitEnvKey(key)).toBe(true)
    }
  })

  it('keeps ordinary environment keys', () => {
    expect(shouldScrubHostGitEnvKey('PATH')).toBe(false)
    expect(shouldScrubHostGitEnvKey('HOME')).toBe(false)
  })

  it('removes secrets and GIT_ keys from the built environment', () => {
    const env = hostGitEnvironment({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'secret',
      GIT_DIR: '/elsewhere/.git',
      SSH_ASKPASS: '/tmp/evil',
      UNSET: undefined
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('GIT_DIR')
    expect(env).not.toHaveProperty('SSH_ASKPASS')
    expect(env).not.toHaveProperty('UNSET')
  })

  it('SETS GIT_TERMINAL_PROMPT=0 AFTER the scrub — order is load-bearing', () => {
    // GIT_TERMINAL_PROMPT starts with GIT_, so the scrub deletes it. If the
    // assignment happened before or inside the scrub loop it would be removed
    // again and git would BLOCK waiting for credentials — a hang, not an error.
    // This test fails if the order is ever inverted.
    const env = hostGitEnvironment({ PATH: '/usr/bin' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('overrides a hostile inherited GIT_TERMINAL_PROMPT rather than inheriting it', () => {
    const env = hostGitEnvironment({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '1' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})

describe('read-only argv guard', () => {
  it.each([['status'], ['diff'], ['log'], ['branch'], ['rev-parse']])(
    'admits the read subcommand %s',
    (subcommand) => {
      expect(() => assertReadOnlyHostGitArgs([subcommand])).not.toThrow()
    }
  )

  it.each([['show'], ['blame'], ['commit'], ['push'], ['fetch'], ['clean'], ['checkout']])(
    'refuses %s — an allowlist, so unknown subcommands are refused not inspected',
    (subcommand) => {
      expect(() => assertReadOnlyHostGitArgs([subcommand])).toThrow(HostGitRefusedError)
    }
  )

  it('refuses caller-supplied -c, which could undo the hardening', () => {
    expect(() => assertReadOnlyHostGitArgs(['-c', 'core.hooksPath=/tmp/evil', 'status'])).toThrow(
      /refuses the argument/
    )
    expect(() => assertReadOnlyHostGitArgs(['--config-env=x=y', 'status'])).toThrow(
      HostGitRefusedError
    )
  })

  it.each([
    ['--exec=evil'],
    ['--exec-path=/tmp'],
    ['--upload-pack=evil'],
    ['--receive-pack=evil'],
    ['--output=/tmp/out']
  ])('refuses %s', (arg) => {
    expect(() => assertReadOnlyHostGitArgs(['diff', arg])).toThrow(HostGitRefusedError)
  })

  it('refuses control characters in argv', () => {
    expect(() => assertReadOnlyHostGitArgs(['status', 'a\nb'])).toThrow(/control characters/)
  })

  it('refuses an argv with no subcommand at all', () => {
    expect(() => assertReadOnlyHostGitArgs(['--no-pager'])).toThrow(HostGitRefusedError)
  })
})

describe('executable identification', () => {
  it.each([
    ['git', true],
    ['/usr/bin/git', true],
    ['C:\\Program Files\\Git\\bin\\git.exe', true],
    ['gh', false],
    ['not-git', false]
  ])('classifies %s as git=%s', (command, expected) => {
    expect(isGitExecutable(command)).toBe(expected)
  })
})
