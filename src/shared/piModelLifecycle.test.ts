import { describe, expect, it } from 'vitest'
import {
  activePiModelRows,
  hasReachedPiModelRetirementDate,
  isPiModelRetired,
  piModelRetiresAt
} from './piModelLifecycle'

describe('Pi model lifecycle', () => {
  it('records verified upstream sunsets while leaving neighboring models active', () => {
    expect(piModelRetiresAt('cerebras/zai-glm-4.7')).toBe('2026-08-17')
    expect(piModelRetiresAt('openrouter/stealth/ox-alpha')).toBe('2026-08-28')
    // Union Alpha was listed 2026-09-16 with a seven-day TaskWraith window.
    // OpenRouter publishes no sunset of its own, and the user ended the window
    // early on 2026-09-18 — so this date is a product decision twice over, and
    // it must NOT drift back to the original 2026-09-23.
    expect(piModelRetiresAt('openrouter/stealth/union-alpha')).toBe('2026-09-18')
    expect(piModelRetiresAt('openrouter/stealth/union-alpha')).not.toBe('2026-09-23')
    expect(piModelRetiresAt('zai/glm-4.7')).toBeUndefined()
    expect(piModelRetiresAt('cerebras/gpt-oss-120b')).toBeUndefined()
    expect(piModelRetiresAt('openrouter/z-ai/glm-5.2')).toBeUndefined()
  })

  it('takes the date-only sunset at the start of the local calendar day', () => {
    expect(isPiModelRetired('cerebras/zai-glm-4.7', new Date(2026, 7, 16, 23, 59))).toBe(false)
    expect(isPiModelRetired('cerebras/zai-glm-4.7', new Date(2026, 7, 17, 0, 0))).toBe(true)
    expect(isPiModelRetired('cerebras/zai-glm-4.7', new Date(2026, 7, 18, 0, 0))).toBe(true)
    expect(isPiModelRetired('openrouter/stealth/ox-alpha', new Date(2026, 7, 27, 23, 59))).toBe(
      false
    )
    expect(isPiModelRetired('openrouter/stealth/ox-alpha', new Date(2026, 7, 28, 0, 0))).toBe(true)
    // Offered up to the last moment of 2026-09-17, gone from the start of the
    // 18th — the cut-short date, not the original seven-day 23rd.
    expect(isPiModelRetired('openrouter/stealth/union-alpha', new Date(2026, 8, 17, 23, 59))).toBe(
      false
    )
    expect(isPiModelRetired('openrouter/stealth/union-alpha', new Date(2026, 8, 18, 0, 0))).toBe(
      true
    )
    expect(isPiModelRetired('openrouter/stealth/union-alpha', new Date(2026, 8, 22, 12, 0))).toBe(
      true
    )
  })

  it('fails open for malformed lifecycle dates', () => {
    const now = new Date(2026, 7, 17, 12)
    expect(hasReachedPiModelRetirementDate('2026-02-30', now)).toBe(false)
    expect(hasReachedPiModelRetirementDate('17-08-2026', now)).toBe(false)
    expect(hasReachedPiModelRetirementDate('', now)).toBe(false)
    expect(hasReachedPiModelRetirementDate(undefined, now)).toBe(false)
  })

  it('warns before sunsets and removes reached rows while retaining neighboring routes', () => {
    const rows = [
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      { id: 'cerebras/zai-glm-4.7', label: 'GLM-4.7 (Cerebras)' },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' },
      { id: 'openrouter/stealth/ox-alpha', label: 'Ox Alpha' },
      { id: 'openrouter/z-ai/glm-5.2', label: 'GLM 5.2' }
    ]

    expect(activePiModelRows(rows, new Date(2026, 7, 16))).toEqual([
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      {
        id: 'cerebras/zai-glm-4.7',
        label: 'GLM-4.7 (Cerebras)',
        retiresAt: '2026-08-17'
      },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' },
      {
        id: 'openrouter/stealth/ox-alpha',
        label: 'Ox Alpha',
        retiresAt: '2026-08-28'
      },
      { id: 'openrouter/z-ai/glm-5.2', label: 'GLM 5.2' }
    ])
    expect(activePiModelRows(rows, new Date(2026, 7, 17))).toEqual([
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' },
      {
        id: 'openrouter/stealth/ox-alpha',
        label: 'Ox Alpha',
        retiresAt: '2026-08-28'
      },
      { id: 'openrouter/z-ai/glm-5.2', label: 'GLM 5.2' }
    ])
    expect(activePiModelRows(rows, new Date(2026, 7, 28))).toEqual([
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' },
      { id: 'openrouter/z-ai/glm-5.2', label: 'GLM 5.2' }
    ])
  })

  it('retires all three regional MiMo V2 Pro routes while leaving V2.5 and V2.5 Pro active', () => {
    expect(piModelRetiresAt('xiaomi-token-plan-cn/mimo-v2-pro')).toBe('2026-08-30')
    expect(piModelRetiresAt('xiaomi-token-plan-sgp/mimo-v2-pro')).toBe('2026-08-30')
    expect(piModelRetiresAt('xiaomi-token-plan-ams/mimo-v2-pro')).toBe('2026-08-30')

    // The V2.5 pair carries Xiaomi's own later sunset (2026-10-21), never V2
    // Pro's date — so on V2 Pro's day it is still offered, checked below.
    expect(piModelRetiresAt('xiaomi-token-plan-cn/mimo-v2.5')).toBe('2026-10-21')
    expect(piModelRetiresAt('xiaomi-token-plan-sgp/mimo-v2.5')).toBe('2026-10-21')
    expect(piModelRetiresAt('xiaomi-token-plan-ams/mimo-v2.5')).toBe('2026-10-21')
    expect(piModelRetiresAt('xiaomi-token-plan-cn/mimo-v2.5-pro')).toBe('2026-10-21')
    expect(piModelRetiresAt('xiaomi-token-plan-sgp/mimo-v2.5-pro')).toBe('2026-10-21')
    expect(piModelRetiresAt('xiaomi-token-plan-ams/mimo-v2.5-pro')).toBe('2026-10-21')

    expect(
      isPiModelRetired('xiaomi-token-plan-cn/mimo-v2-pro', new Date(2026, 7, 29, 23, 59))
    ).toBe(false)
    expect(isPiModelRetired('xiaomi-token-plan-cn/mimo-v2-pro', new Date(2026, 7, 30, 0, 0))).toBe(
      true
    )
    expect(isPiModelRetired('xiaomi-token-plan-sgp/mimo-v2-pro', new Date(2026, 7, 30, 0, 0))).toBe(
      true
    )
    expect(isPiModelRetired('xiaomi-token-plan-ams/mimo-v2-pro', new Date(2026, 7, 30, 0, 0))).toBe(
      true
    )
    expect(isPiModelRetired('xiaomi-token-plan-cn/mimo-v2.5', new Date(2026, 7, 30, 0, 0))).toBe(
      false
    )
    expect(
      isPiModelRetired('xiaomi-token-plan-cn/mimo-v2.5-pro', new Date(2026, 7, 30, 0, 0))
    ).toBe(false)
  })

  it('drops exactly the three regional MiMo V2 Pro rows from active rows once reached', () => {
    const rows = [
      { id: 'xiaomi-token-plan-cn/mimo-v2-pro', label: 'MiMo V2 Pro (CN)' },
      { id: 'xiaomi-token-plan-cn/mimo-v2.5', label: 'MiMo V2.5 (CN)' },
      { id: 'xiaomi-token-plan-cn/mimo-v2.5-pro', label: 'MiMo V2.5 Pro (CN)' },
      { id: 'xiaomi-token-plan-sgp/mimo-v2-pro', label: 'MiMo V2 Pro (SGP)' },
      { id: 'xiaomi-token-plan-sgp/mimo-v2.5', label: 'MiMo V2.5 (SGP)' },
      { id: 'xiaomi-token-plan-sgp/mimo-v2.5-pro', label: 'MiMo V2.5 Pro (SGP)' },
      { id: 'xiaomi-token-plan-ams/mimo-v2-pro', label: 'MiMo V2 Pro (AMS)' },
      { id: 'xiaomi-token-plan-ams/mimo-v2.5', label: 'MiMo V2.5 (AMS)' },
      { id: 'xiaomi-token-plan-ams/mimo-v2.5-pro', label: 'MiMo V2.5 Pro (AMS)' }
    ]

    const active = activePiModelRows(rows, new Date(2026, 7, 30))
    expect(active.map((row) => row.id)).toEqual([
      'xiaomi-token-plan-cn/mimo-v2.5',
      'xiaomi-token-plan-cn/mimo-v2.5-pro',
      'xiaomi-token-plan-sgp/mimo-v2.5',
      'xiaomi-token-plan-sgp/mimo-v2.5-pro',
      'xiaomi-token-plan-ams/mimo-v2.5',
      'xiaomi-token-plan-ams/mimo-v2.5-pro'
    ])
    expect(active).toHaveLength(rows.length - 3)
  })

  it('dates the V2.5 pair 2026-10-21 on every region and leaves the V2.6 pair undated', () => {
    for (const region of ['cn', 'sgp', 'ams']) {
      const upstream = `xiaomi-token-plan-${region}`
      expect(piModelRetiresAt(`${upstream}/mimo-v2.5`), upstream).toBe('2026-10-21')
      expect(piModelRetiresAt(`${upstream}/mimo-v2.5-pro`), upstream).toBe('2026-10-21')
      expect(piModelRetiresAt(`${upstream}/mimo-v2.6-pro`), upstream).toBeUndefined()
      expect(piModelRetiresAt(`${upstream}/mimo-v2.6-flash`), upstream).toBeUndefined()
      // Xiaomi's cutoff is 10:00 Beijing time on the 21st; the date-only rule
      // drops the rows from the start of that local calendar day.
      expect(isPiModelRetired(`${upstream}/mimo-v2.5`, new Date(2026, 9, 20, 23, 59))).toBe(false)
      expect(isPiModelRetired(`${upstream}/mimo-v2.5`, new Date(2026, 9, 21, 0, 0))).toBe(true)
      expect(isPiModelRetired(`${upstream}/mimo-v2.5-pro`, new Date(2026, 9, 21, 0, 0))).toBe(true)
      expect(isPiModelRetired(`${upstream}/mimo-v2.6-pro`, new Date(2026, 9, 21, 0, 0))).toBe(false)
      expect(isPiModelRetired(`${upstream}/mimo-v2.6-flash`, new Date(2027, 0, 1))).toBe(false)
    }
  })

  it('warns on the V2.5 pair until 2026-10-21, then leaves only the V2.6 pair per region', () => {
    const rows = ['cn', 'sgp', 'ams'].flatMap((region) =>
      ['mimo-v2-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-pro', 'mimo-v2.6-flash'].map(
        (modelId) => ({ id: `xiaomi-token-plan-${region}/${modelId}` })
      )
    )
    expect(rows).toHaveLength(15)

    const warned = activePiModelRows(rows, new Date(2026, 9, 20))
    expect(warned.map((row) => row.id)).toEqual(
      rows.map((row) => row.id).filter((id) => !id.endsWith('/mimo-v2-pro'))
    )
    expect(warned.filter((row) => row.retiresAt === '2026-10-21').map((row) => row.id)).toEqual(
      rows.map((row) => row.id).filter((id) => /\/mimo-v2\.5(-pro)?$/.test(id))
    )
    expect(warned.filter((row) => row.retiresAt).length).toBe(6)

    const after = activePiModelRows(rows, new Date(2026, 9, 21))
    expect(after.map((row) => row.id)).toEqual([
      'xiaomi-token-plan-cn/mimo-v2.6-pro',
      'xiaomi-token-plan-cn/mimo-v2.6-flash',
      'xiaomi-token-plan-sgp/mimo-v2.6-pro',
      'xiaomi-token-plan-sgp/mimo-v2.6-flash',
      'xiaomi-token-plan-ams/mimo-v2.6-pro',
      'xiaomi-token-plan-ams/mimo-v2.6-flash'
    ])
    expect(after.every((row) => row.retiresAt === undefined)).toBe(true)
  })
})
