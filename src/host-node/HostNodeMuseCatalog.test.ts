import { expect, it } from 'vitest'
import { MUSE_DEFAULT_MODEL, MUSE_REASONING_EFFORTS } from '../main/muse/MuseCliArgs'
import {
  HOST_NODE_MUSE_CONTRIBUTOR_MODEL_ID,
  HOST_NODE_MUSE_MODEL_ID,
  HOST_NODE_MUSE_REASONING,
  hostNodeMuseInventory,
  hostNodeMuseOffers
} from './HostNodeMuseCatalog'

it('offers both Muse Spark 1.2 routes with the exact bounded reasoning and posture catalog', () => {
  const offers = hostNodeMuseOffers()
  expect(
    offers.models.map(({ modelId, label, default: isDefault }) => ({
      modelId,
      label,
      isDefault: Boolean(isDefault)
    }))
  ).toEqual([
    { modelId: HOST_NODE_MUSE_MODEL_ID, label: 'Muse Spark 1.2', isDefault: true },
    {
      modelId: HOST_NODE_MUSE_CONTRIBUTOR_MODEL_ID,
      label: 'Muse Contributor Spark 1.2',
      isDefault: false
    }
  ])
  expect(offers.models[1]?.detail).toMatch(/content.*product improvement/i)
  for (const model of offers.models) {
    expect(model.reasoning.map((item) => item.reasoningId)).toEqual(HOST_NODE_MUSE_REASONING)
  }
  expect(offers.postures.map((posture) => posture.postureId)).toEqual([
    'plan',
    'read_only',
    'default',
    'workspace_write',
    'full_access'
  ])
  expect(offers.postures.map((posture) => posture.label)).toEqual([
    'Plan',
    'Ask',
    'Accept Edits',
    'Full WS Access',
    'Full Access (YOLO)'
  ])
  expect(offers.postures.at(-1)).toMatchObject({
    available: false,
    requiresExplicitConsent: true,
    ceiling: 'full_access'
  })
  expect(
    hostNodeMuseInventory(true).map(({ modelId, modelLabel, available }) => ({
      modelId,
      modelLabel,
      available
    }))
  ).toEqual([
    { modelId: HOST_NODE_MUSE_MODEL_ID, modelLabel: 'Muse Spark 1.2', available: true },
    {
      modelId: HOST_NODE_MUSE_CONTRIBUTOR_MODEL_ID,
      modelLabel: 'Muse Contributor Spark 1.2',
      available: true
    }
  ])
  expect(HOST_NODE_MUSE_MODEL_ID).toBe(MUSE_DEFAULT_MODEL)
  expect(HOST_NODE_MUSE_REASONING).toEqual(MUSE_REASONING_EFFORTS)
  expect(offers.models[0]?.reasoning.map((item) => item.label)).toEqual([
    'Minimal',
    'Low',
    'Medium',
    'High',
    'Extra High',
    'Ultra'
  ])
})
