import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { sealRunToolReceipt, sealRunToolReceiptAfter } from './RunToolCapabilitySettlement'

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

describe('sealRunToolReceiptAfter', () => {
  it('seals after the cleanup resolves, and returns the cleanup value', async () => {
    const settle = vi.fn()
    await expect(sealRunToolReceiptAfter({ settle }, async () => 'drained')).resolves.toBe(
      'drained'
    )
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('still seals when the cleanup rejects, and propagates that rejection unchanged', async () => {
    const settle = vi.fn()
    const failure = new Error('permission lease release failed')
    await expect(
      sealRunToolReceiptAfter({ settle }, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('never lets a reporting failure replace the failure that ended the run', async () => {
    const failure = new Error('permission lease release failed')
    await expect(
      sealRunToolReceiptAfter(
        {
          settle: () => {
            throw new Error('receipt reporting blew up')
          }
        },
        async () => {
          throw failure
        }
      )
    ).rejects.toBe(failure)
  })

  it('tolerates a run that never created a receipt', async () => {
    await expect(sealRunToolReceiptAfter(undefined, async () => 'ok')).resolves.toBe('ok')
    await expect(sealRunToolReceiptAfter(null, () => 'ok')).resolves.toBe('ok')
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
    expect(region).toContain('sealRunToolReceiptAfter(agyToolReceipt')
    // The previous ordering sealed only after an awaited cleanup that rethrows.
    expect(region).not.toMatch(/await releasePermissionLease\(\)\n\s*agyToolReceipt\?\.settle\(\)/)
  })

  it('the ACP lane seals inside its idempotent terminal handler', () => {
    const region = providerRegion('async function runAntigravityOfficialAcpProvider(').join('\n')
    expect(region).toContain('sealRunToolReceipt(agyAcpToolReceipt)')
  })
})
