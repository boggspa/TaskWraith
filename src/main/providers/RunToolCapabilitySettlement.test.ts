import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { sealRunToolReceipt, sealRunToolReceiptAfterCleanup } from './RunToolCapabilitySettlement'

const mainSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

/** The source lines of one composition-root provider function. */
function providerRegion(signature: string): string[] {
  const start = mainSource.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const rest = mainSource.slice(start)
  const end = rest.indexOf('\n}\n')
  expect(end).toBeGreaterThan(-1)
  return rest.slice(0, end).split('\n')
}

describe('sealRunToolReceiptAfterCleanup', () => {
  it('runs a later step even when an earlier one rejects', async () => {
    const order: string[] = []
    const settle = vi.fn()
    await expect(
      sealRunToolReceiptAfterCleanup({ settle }, [
        async () => {
          order.push('drain')
          throw new Error('drain failed')
        },
        async () => {
          order.push('release')
        }
      ])
    ).rejects.toThrow('drain failed')
    // The release step is the one that restores the user's settings overlay.
    expect(order).toEqual(['drain', 'release'])
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('rethrows the FIRST failure, not the last', async () => {
    const first = new Error('drain failed')
    const second = new Error('release failed')
    await expect(
      sealRunToolReceiptAfterCleanup(undefined, [
        () => Promise.reject(first),
        () => Promise.reject(second)
      ])
    ).rejects.toBe(first)
  })

  it('seals once and resolves when every step succeeds', async () => {
    const settle = vi.fn()
    const order: string[] = []
    await expect(
      sealRunToolReceiptAfterCleanup({ settle }, [
        () => order.push('a'),
        async () => void order.push('b')
      ])
    ).resolves.toBeUndefined()
    expect(order).toEqual(['a', 'b'])
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('seals even when every step rejects, and tolerates no receipt', async () => {
    const settle = vi.fn()
    await expect(
      sealRunToolReceiptAfterCleanup({ settle }, [
        () => Promise.reject(new Error('one')),
        () => Promise.reject(new Error('two'))
      ])
    ).rejects.toThrow('one')
    expect(settle).toHaveBeenCalledTimes(1)
    await expect(sealRunToolReceiptAfterCleanup(null, [])).resolves.toBeUndefined()
  })
})

describe('sealRunToolReceipt', () => {
  it('seals the receipt and swallows a throwing reporter', () => {
    const settle = vi.fn()
    sealRunToolReceipt({ settle })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(() =>
      sealRunToolReceipt({
        settle: () => {
          throw new Error('receipt reporting blew up')
        }
      })
    ).not.toThrow()
    expect(() => sealRunToolReceipt(undefined)).not.toThrow()
  })
})

describe('the Pi lane seals its run tool receipt', () => {
  it('creates the receipt after every early exit, so none can strand it', () => {
    const lines = providerRegion('async function runPiProvider(')
    const created = lines.findIndex((line) =>
      line.includes('const piToolReceipt = recordProviderToolCapability(')
    )
    expect(created).toBeGreaterThan(-1)

    // Every early exit in this function sits at two or three indent levels;
    // deeper returns belong to inner callbacks, which cannot end the turn.
    // Matching `return` anywhere on the line catches `if (x) return` too.
    const earlyExit = (line: string): boolean => /^ {2,6}(\S.*\s)?return\b/.test(line)
    // Pi validates model, images, isolation and tool preparation BEFORE the
    // receipt exists, which is what makes one seal at the end sufficient.
    // Moving creation above those gates, or adding any exit below it, reds this.
    expect(lines.filter((line, index) => index > created && earlyExit(line))).toEqual([])
    // Without this the assertion above passes vacuously should the region
    // extraction ever stop matching the real early exits.
    expect(
      lines.filter((line, index) => index < created && earlyExit(line)).length
    ).toBeGreaterThan(0)
  })

  it('seals on any turn outcome and records the extension handshake', () => {
    const region = providerRegion('async function runPiProvider(').join('\n')
    expect(region).toContain('sealRunToolReceiptAfterCleanup(piToolReceipt, [() => piTurn])')
    // The marker callback is the only attachment evidence this lane has.
    expect(region).toContain('recordPiAttachedTools(piToolReceipt, piManagedToolNames)')
  })
})

describe('every AntiGravity terminal path seals its run tool receipt', () => {
  it.each([
    ['agy print-mode', 'async function runAntigravityAgyProvider(', 'agyToolReceipt'],
    ['official ACP', 'async function runAntigravityOfficialAcpProvider(', 'agyAcpToolReceipt']
  ])(
    '%s: no early return taken after the receipt exists can leave it unsealed',
    (_label, signature, binding) => {
      const lines = providerRegion(signature)
      const created = lines.findIndex((line) =>
        line.includes(`const ${binding} = recordProviderToolCapability(`)
      )
      expect(created).toBeGreaterThan(-1)

      const strandedReturns = lines
        .map((line, index) => ({ line, index }))
        .filter((row) => row.index > created && /^[ \t]*return[ \t]*$/.test(row.line))

      // Without this the loop below passes vacuously if the region extraction
      // ever stops matching the real early exits.
      expect(strandedReturns.length).toBeGreaterThan(0)

      for (const row of strandedReturns) {
        const preceding = lines.slice(Math.max(0, row.index - 3), row.index).join('\n')
        expect(preceding).toMatch(/sealRunToolReceipt\(|finishTurn\(/)
      }
    }
  )

  it('the agy cleanup seals the receipt even when releasing the permission lease rejects', () => {
    const region = providerRegion('async function runAntigravityAgyProvider(').join('\n')
    expect(region).toContain('sealRunToolReceiptAfterCleanup(agyToolReceipt, [')
    // Both steps must be present: dropping the lease release is the failure
    // this ordering exists to prevent.
    expect(region).toContain('brainTranscriptMonitor.stopAndDrain()')
    expect(region).toContain('releasePermissionLease()')
    // The previous ordering sealed only after an awaited cleanup that rethrows.
    expect(region).not.toMatch(/await releasePermissionLease\(\)\n\s*agyToolReceipt\?\.settle\(\)/)
  })

  it('the ACP lane seals inside its idempotent terminal handler', () => {
    const region = providerRegion('async function runAntigravityOfficialAcpProvider(').join('\n')
    expect(region).toContain('sealRunToolReceipt(agyAcpToolReceipt)')
  })
})
