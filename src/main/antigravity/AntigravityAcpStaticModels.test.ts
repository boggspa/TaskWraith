import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_ACP_MODEL_ID_PREFIX,
  ANTIGRAVITY_ACP_MODEL_NAMESPACE,
  antigravityAcpStaticModels,
  isAntigravityAcpCatalogModelId,
  toAntigravityAcpModelId
} from './AntigravityAcpStaticModels'
import { antigravityAgyStaticModels } from './AntigravityAgyStaticModels'
import { isAntigravityAcpModelCandidate } from './AntigravityCombinedModeDispatch'
import { sanitizeAntigravityCatalogCache } from '../../shared/antigravityCatalogCache.node'

describe('AntigravityAcpStaticModels', () => {
  it('pins the namespace and prefix the dispatch arm keys on', () => {
    expect(ANTIGRAVITY_ACP_MODEL_NAMESPACE).toBe('antigravity-acp')
    expect(ANTIGRAVITY_ACP_MODEL_ID_PREFIX).toBe('antigravity-acp:')
  })

  // The whole point of the namespace: without it nothing a user can pick ever
  // satisfies the committed dispatch predicate, so the ACP lane is dead code.
  it('emits ids the committed dispatch predicate actually routes to the ACP lane', () => {
    const rows = antigravityAcpStaticModels()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(isAntigravityAcpModelCandidate(row.id)).toBe(true)
    }
    expect(rows[0]).toEqual({
      id: 'antigravity-acp:gemini-3.8-flash-high',
      label: 'gemini-3.8-flash-high'
    })
  })

  // Documents WHY the separator is `:` and must never become `-` or a letter:
  // the predicate reserves the token only on a non-[a-z0-9-] continuation.
  it('uses a separator that is a token boundary, not an alphanumeric continuation', () => {
    expect(isAntigravityAcpModelCandidate('antigravity-acp:gemini-3.8-flash-high')).toBe(true)
    expect(isAntigravityAcpModelCandidate('antigravity-acpx')).toBe(false)
    expect(isAntigravityAcpModelCandidate('antigravity-acp-extra')).toBe(false)
    expect(isAntigravityAcpModelCandidate('antigravity-acp2')).toBe(false)
  })

  it('is idempotent so a doubly projected row can never be double-prefixed', () => {
    const once = toAntigravityAcpModelId('gemini-3.8-flash-high')
    expect(once).toBe('antigravity-acp:gemini-3.8-flash-high')
    expect(toAntigravityAcpModelId(once)).toBe(once)
    expect(toAntigravityAcpModelId(toAntigravityAcpModelId(once))).toBe(once)
    expect(once.startsWith('antigravity-acp:antigravity-acp:')).toBe(false)
  })

  it('classifies ACP rows the same way dispatch normalizes them', () => {
    expect(isAntigravityAcpCatalogModelId('antigravity-acp:gemini-3.8-flash-high')).toBe(true)
    expect(isAntigravityAcpCatalogModelId('  ANTIGRAVITY-ACP:gemini-3.8-flash-high  ')).toBe(true)
    // Legacy agy and Gemini API rows are emphatically NOT ACP rows: the quota
    // gate keys off this, and misclassifying an agy row would close a meter
    // that should be open.
    expect(isAntigravityAcpCatalogModelId('gemini-3.8-flash-high')).toBe(false)
    expect(isAntigravityAcpCatalogModelId('gemini-api:gemini-3.6-flash')).toBe(false)
    expect(isAntigravityAcpCatalogModelId('antigravity-acpx')).toBe(false)
    expect(isAntigravityAcpCatalogModelId(undefined)).toBe(false)
    expect(isAntigravityAcpCatalogModelId(42)).toBe(false)
  })

  // The catalogue is published to the external Host, whose sanitizer drops any
  // row failing its id charset. A namespace the Host rejected would offer the
  // lane in-app and silently nowhere else, so pin that the `:` survives.
  it('emits ids the external Host catalogue cache accepts verbatim', () => {
    const rows = antigravityAcpStaticModels()
    const mirrored = sanitizeAntigravityCatalogCache({ version: 1, models: rows })
    expect(mirrored).toHaveLength(rows.length)
    expect(mirrored[0]?.id).toBe('antigravity-acp:gemini-3.8-flash-high')
  })

  it('mirrors the agy floor one-to-one and keeps the bare id as the label', () => {
    const agy = antigravityAgyStaticModels()
    const acp = antigravityAcpStaticModels()
    expect(acp).toHaveLength(agy.length)
    expect(acp.map((row) => row.id)).toEqual(agy.map((row) => `antigravity-acp:${row.id}`))
    // Labels stay bare so the shared picker grouping derives the same family
    // label and effort ladder it derives for the agy floor.
    expect(acp.map((row) => row.label)).toEqual(agy.map((row) => row.label))
    expect(acp.every((row) => !row.label.includes('antigravity-acp'))).toBe(true)
  })
})
