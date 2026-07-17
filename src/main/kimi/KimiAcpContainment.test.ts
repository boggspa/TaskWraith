import { describe, it, expect } from 'vitest'
import { resolve, relative } from 'path'
import {
  KIMI_ACP_DENY_TOOLS,
  buildKimiDenyWall,
  buildKimiIsolatedConfig,
  forceTelemetryOff,
  forceThinkingEffort,
  forceThinkingMode,
  isPathWithinRoots,
  stripAllowPermissionRules
} from './KimiAcpContainment'

describe('stripAllowPermissionRules', () => {
  it('drops allow blocks but keeps deny/ask blocks and other config', () => {
    const input = [
      'default_model = "kimi-code/kimi-for-coding"',
      '',
      '[[permission.rules]]',
      'decision = "allow"',
      'pattern = "Bash(rm -rf*)"',
      '',
      '[[permission.rules]]',
      'decision = "deny"',
      'pattern = "FetchURL"',
      '',
      '[[permission.rules]]',
      'decision = "ask"',
      'pattern = "Bash"',
      '',
      '[thinking]',
      'enabled = true'
    ].join('\n')
    const out = stripAllowPermissionRules(input)
    expect(out).not.toContain('Bash(rm -rf*)')
    expect(out).toContain('pattern = "FetchURL"')
    expect(out).toContain('decision = "ask"')
    expect(out).toContain('[thinking]')
    expect(out).toContain('enabled = true')
  })

  it('strips an allow rule that sits as the final block (EOF-terminated)', () => {
    const input = '[providers.x]\nkey = 1\n\n[[permission.rules]]\ndecision = "allow"\npattern = "Read"'
    const out = stripAllowPermissionRules(input)
    expect(out).toContain('[providers.x]')
    expect(out).not.toContain('pattern = "Read"')
  })

  it('leaves a config with no permission rules untouched in substance', () => {
    const input = 'telemetry = true\n\n[thinking]\nenabled = false'
    expect(stripAllowPermissionRules(input)).toContain('[thinking]')
  })

  it('handles single-quoted decision values', () => {
    const input = "[[permission.rules]]\ndecision = 'allow'\npattern = \"X\""
    expect(stripAllowPermissionRules(input)).not.toContain('pattern = "X"')
  })
})

describe('forceTelemetryOff', () => {
  it('replaces an existing telemetry = true', () => {
    expect(forceTelemetryOff('telemetry = true\n[thinking]\nenabled=true')).toContain(
      'telemetry = false'
    )
    expect(forceTelemetryOff('telemetry = true')).not.toContain('telemetry = true')
  })

  it('inserts telemetry = false before the first table when absent', () => {
    const out = forceTelemetryOff('default_model = "x"\n\n[thinking]\nenabled = true')
    expect(out).toContain('telemetry = false')
    // It must land before [thinking] (top-level scope).
    expect(out.indexOf('telemetry = false')).toBeLessThan(out.indexOf('[thinking]'))
  })

  it('appends when there is no table header at all', () => {
    expect(forceTelemetryOff('default_model = "x"')).toContain('telemetry = false')
  })
})

describe('buildKimiIsolatedConfig', () => {
  const base = [
    'default_model = "kimi-code/kimi-for-coding"',
    'telemetry = true',
    '',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "Bash"',
    '',
    '[services.moonshot_search]',
    'base_url = "https://api.kimi.com/coding/v1/search"'
  ].join('\n')

  it('forces telemetry off, strips allow rules, and appends the egress deny wall', () => {
    const out = buildKimiIsolatedConfig({ baseConfig: base })
    expect(out).toContain('telemetry = false')
    expect(out).not.toContain('telemetry = true')
    // The migrated allow rule for Bash is gone (B8).
    expect(out).not.toMatch(/decision = "allow"\npattern = "Bash"/)
    // Every default-denied tool has a deny rule.
    for (const tool of KIMI_ACP_DENY_TOOLS) {
      expect(out).toContain(`pattern = "${tool}"`)
    }
    expect(out).toContain('TaskWraith-managed isolated Kimi Code profile')
  })

  it('honours extra deny tools', () => {
    const out = buildKimiIsolatedConfig({ baseConfig: base, extraDenyTools: ['Bash'] })
    expect(out).toContain('pattern = "Bash"')
  })

  it('forces K3 thinking on at the selected effort', () => {
    const out = buildKimiIsolatedConfig({
      baseConfig: `${base}\n\n[thinking]\nenabled = false\neffort = "low"`,
      thinkingEnabled: true,
      thinkingEffort: 'high'
    })
    expect(out).toContain('[thinking]\nenabled = true\neffort = "high"')
    expect(forceThinkingEffort('[thinking]\nenabled = true', 'max')).toContain(
      '[thinking]\neffort = "max"\nenabled = true'
    )
  })

  it('denies the server-side fs/exec escapers, not just egress (CI guard for the live probe)', () => {
    // Verified live (KimiAcpEscapeProbe.live.test.ts): built-in Bash (`cat`, and
    // `echo >` which WROTE outside the workspace) and Glob (list/find) run
    // server-side and bypass the client fs authority, reading AND writing
    // absolute paths outside the workspace roots. Read/Write/Edit route through
    // the client fs handler and stay boundary-enforced. These must remain denied
    // so all fs/exec goes through the client fs handler or the confined gateway;
    // the live probe proves it but is gated out of CI, so lock it here too.
    for (const escaper of ['Bash', 'Glob', 'Grep']) {
      expect(KIMI_ACP_DENY_TOOLS as readonly string[]).toContain(escaper)
    }
    for (const egress of ['FetchURL', 'WebSearch', 'AgentSwarm']) {
      expect(KIMI_ACP_DENY_TOOLS as readonly string[]).toContain(egress)
    }
  })
})

describe('forceThinkingMode', () => {
  it('replaces enabled under an existing [thinking] table', () => {
    expect(forceThinkingMode('[thinking]\nenabled = true', false)).toBe(
      '[thinking]\nenabled = false'
    )
    expect(forceThinkingMode('[thinking]\nenabled = false', true)).toContain('enabled = true')
  })

  it('adds enabled to a [thinking] table that lacks it', () => {
    const out = forceThinkingMode('[thinking]\nbudget = 5', false)
    expect(out).toContain('enabled = false')
    expect(out).toContain('budget = 5')
  })

  it('appends a [thinking] table when absent', () => {
    const out = forceThinkingMode('default_model = "x"', true)
    expect(out).toContain('[thinking]')
    expect(out).toContain('enabled = true')
  })

  it('does not cross into the next table', () => {
    const out = forceThinkingMode('[thinking]\nbudget = 5\n\n[other]\nenabled = true', false)
    // The [other] table's enabled must stay true; a new enabled lands in [thinking].
    expect(out).toMatch(/\[thinking\]\nenabled = false/)
    expect(out).toContain('[other]\nenabled = true')
  })
})

describe('buildKimiIsolatedConfig thinking control', () => {
  it('forces thinking off when requested, leaves it when omitted', () => {
    const base = 'telemetry = true\n\n[thinking]\nenabled = true'
    expect(buildKimiIsolatedConfig({ baseConfig: base, thinkingEnabled: false })).toContain(
      'enabled = false'
    )
    expect(buildKimiIsolatedConfig({ baseConfig: base })).toContain('enabled = true')
  })
})

describe('buildKimiDenyWall', () => {
  it('emits one deny table per tool', () => {
    const wall = buildKimiDenyWall(['FetchURL', 'WebSearch'])
    expect(wall.match(/\[\[permission.rules\]\]/g)).toHaveLength(2)
    expect(wall).toContain('decision = "deny"')
  })
})

describe('isPathWithinRoots', () => {
  const helpers = { resolve, relative }

  it('authorises a file inside the workspace root', () => {
    expect(isPathWithinRoots('/ws/src/a.ts', ['/ws'], helpers)).toBe(true)
    expect(isPathWithinRoots('/ws', ['/ws'], helpers)).toBe(true)
  })

  it('refuses a path outside every root', () => {
    expect(isPathWithinRoots('/etc/passwd', ['/ws'], helpers)).toBe(false)
    expect(isPathWithinRoots('/ws/../secret', ['/ws'], helpers)).toBe(false)
  })

  it('does not treat a sibling prefix as inside (/ws vs /ws-secrets)', () => {
    expect(isPathWithinRoots('/ws-secrets/x', ['/ws'], helpers)).toBe(false)
  })

  it('authorises via an external grant root', () => {
    expect(isPathWithinRoots('/grant/data.json', ['/ws', '/grant'], helpers)).toBe(true)
  })

  it('refuses empty targets and empty roots', () => {
    expect(isPathWithinRoots('', ['/ws'], helpers)).toBe(false)
    expect(isPathWithinRoots('/ws/a', [''], helpers)).toBe(false)
    expect(isPathWithinRoots('/ws/a', [], helpers)).toBe(false)
  })
})
