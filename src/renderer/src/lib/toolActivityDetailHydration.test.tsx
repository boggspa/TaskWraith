import { describe, expect, it, vi } from 'vitest'
import type {
  HydratedToolActivityDetail,
  ToolActivity,
  ToolActivityDetailRef
} from '../../../main/store/types'
import {
  hydrateToolActivitiesOnDemand,
  mergeHydratedToolActivityDetails
} from './toolActivityDetailHydration'

function ref(activityId: string, offset = 0): ToolActivityDetailRef {
  return {
    schemaVersion: 1,
    storage: 'run_event_artifact',
    runId: 'run-1',
    activityId,
    offset,
    byteLength: 100,
    sha256: activityId.padEnd(64, 'a').slice(0, 64)
  }
}

function compact(activityId: string, offset = 0): ToolActivity {
  return {
    id: activityId,
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    detailRef: ref(activityId, offset)
  }
}

function hydrated(activity: ToolActivity): HydratedToolActivityDetail {
  return { ref: activity.detailRef!, activity: { ...activity, detailRef: undefined } }
}

describe('tool activity detail hydration', () => {
  it('merges heavyweight detail while keeping the compact row presentation authoritative', () => {
    const row = compact('tool-1')
    const details = new Map([
      [
        [row.detailRef!.runId, row.detailRef!.activityId, 0, 100, row.detailRef!.sha256].join(':'),
        {
          ...row,
          status: 'running' as const,
          parameters: { command: 'printf hello' },
          resultSummary: 'hello'
        }
      ]
    ])

    expect(mergeHydratedToolActivityDetails([row], details)[0]).toMatchObject({
      status: 'success',
      parameters: { command: 'printf hello' },
      resultSummary: 'hello',
      detailRef: row.detailRef
    })
  })

  it('loads bounded batches and leaves rows unchanged when hydration is unavailable', async () => {
    const rows = Array.from({ length: 260 }, (_, index) => compact(`tool-${index}`, index * 100))
    const loader = vi.fn(async (refs: ToolActivityDetailRef[]) =>
      refs.map((detailRef) =>
        hydrated({
          ...rows.find((row) => row.id === detailRef.activityId)!,
          parameters: { command: detailRef.activityId }
        })
      )
    )
    const result = await hydrateToolActivitiesOnDemand(rows, loader)

    expect(loader.mock.calls.map(([batch]) => batch.length)).toEqual([128, 128, 4])
    expect(result[259].parameters).toEqual({ command: 'tool-259' })

    const unavailable = vi.fn(async () => [])
    expect(await hydrateToolActivitiesOnDemand(rows.slice(0, 1), unavailable)).toEqual(
      rows.slice(0, 1)
    )
  })
})
