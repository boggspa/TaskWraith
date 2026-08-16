import { describe, expect, it } from 'vitest'
import {
  createBlackboardDeleteReceipt,
  projectBlackboardDeleteResultForModel,
  type BlackboardDeleteReceipt
} from './BlackboardDeleteReceipt'

describe('createBlackboardDeleteReceipt', () => {
  it('returns only bounded count metadata', () => {
    const receipt = createBlackboardDeleteReceipt({ removedCount: 60, remainingCount: 0 })

    expect(receipt).toEqual<BlackboardDeleteReceipt>({
      ok: true,
      tool: 'blackboard_delete',
      removedCount: 60,
      remainingCount: 0,
      deletedContentOmitted: true
    })
    expect(receipt).not.toHaveProperty('removed')
    expect(Buffer.byteLength(JSON.stringify(receipt), 'utf8')).toBeLessThan(256)
  })

  it('drops every deleted entry body from a legacy bulk result', () => {
    const privateBody = 'do-not-echo-this-body'.repeat(400)
    const projected = projectBlackboardDeleteResultForModel({
      ok: true,
      tool: 'blackboard_delete',
      removed: Array.from({ length: 60 }, (_, index) => ({
        id: `entry-${index}`,
        key: `key-${index}`,
        value: privateBody
      })),
      removedCount: 60,
      remainingCount: 0
    })
    const serialized = JSON.stringify(projected)

    expect(projected).toEqual(
      createBlackboardDeleteReceipt({ removedCount: 60, remainingCount: 0 })
    )
    expect(serialized).not.toContain(privateBody)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(256)
  })

  it('leaves unrelated and failed tool results unchanged', () => {
    const error = { ok: false, tool: 'blackboard_delete', error: 'No match.' }
    const other = { ok: true, tool: 'another_tool', removed: ['still-needed'] }

    expect(projectBlackboardDeleteResultForModel(error)).toBe(error)
    expect(projectBlackboardDeleteResultForModel(other)).toBe(other)
  })
})
