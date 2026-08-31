import { describe, expect, it } from 'vitest'
import { redactPermissionOpportunityIdsForDurableStorage } from './permissionOpportunityRedaction'

describe('permission-opportunity durable redaction', () => {
  it('redacts ids from nested objects, arrays, text, and encoded JSON without mutating the input', () => {
    const opportunityId = `twp_${'d'.repeat(43)}`
    const input = {
      permissionOpportunityId: opportunityId,
      nested: [{ message: `retry failed for ${opportunityId}` }],
      encoded: JSON.stringify({ permissionOpportunityId: opportunityId })
    }

    const redacted = redactPermissionOpportunityIdsForDurableStorage(input)

    expect(JSON.stringify(redacted)).not.toContain(opportunityId)
    expect(redacted.permissionOpportunityId).toBe('[redacted]')
    expect(redacted.nested[0]?.message).toContain('[redacted permission opportunity]')
    expect(JSON.parse(redacted.encoded)).toMatchObject({
      permissionOpportunityId: '[redacted]',
      permissionOpportunityIdRedacted: true
    })
    expect(input.permissionOpportunityId).toBe(opportunityId)
  })

  it('fails closed on circular and excessively deep values', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const deeplyNested = Array.from({ length: 30 }).reduce<unknown>((value) => ({ value }), 'leaf')

    expect(redactPermissionOpportunityIdsForDurableStorage(circular)).toMatchObject({
      self: '[redacted circular value]',
      permissionOpportunityIdRedacted: true
    })
    expect(JSON.stringify(redactPermissionOpportunityIdsForDurableStorage(deeplyNested))).toContain(
      '[redacted nested value]'
    )
  })
})
