import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import type {
  HydratedToolActivityDetail,
  ToolActivity,
  ToolActivityDetailRef
} from '../../../main/store/types'

const TOOL_DETAIL_HYDRATION_BATCH_SIZE = 128

export type ToolActivityDetailLoader = (
  refs: ToolActivityDetailRef[]
) => Promise<HydratedToolActivityDetail[]>

function detailKey(ref: ToolActivityDetailRef): string {
  return [ref.runId, ref.activityId, ref.offset, ref.byteLength, ref.sha256].join(':')
}

function detailRefFor(activity: ToolActivity): ToolActivityDetailRef | null {
  const ref = activity.detailRef
  return ref?.schemaVersion === 1 && ref.storage === 'run_event_artifact' ? ref : null
}

export function mergeHydratedToolActivityDetails(
  activities: readonly ToolActivity[],
  details: ReadonlyMap<string, ToolActivity>
): ToolActivity[] {
  let changed = false
  const merged = activities.map((activity) => {
    const ref = detailRefFor(activity)
    const detail = ref ? details.get(detailKey(ref)) : undefined
    if (!detail) return activity
    changed = true
    // The durable checkpoint owns heavyweight fields. The compact transcript
    // owns live presentation/status fields and its authenticated pointer.
    return { ...detail, ...activity }
  })
  return changed ? merged : (activities as ToolActivity[])
}

async function defaultLoader(refs: ToolActivityDetailRef[]): Promise<HydratedToolActivityDetail[]> {
  if (typeof window.api?.getToolActivityDetails !== 'function') return []
  return window.api.getToolActivityDetails(refs)
}

const inFlightBatches = new Map<string, Promise<HydratedToolActivityDetail[]>>()

function loadBatchOnce(
  refs: ToolActivityDetailRef[],
  loader: ToolActivityDetailLoader
): Promise<HydratedToolActivityDetail[]> {
  const key = refs.map(detailKey).join('|')
  const existing = inFlightBatches.get(key)
  if (existing) return existing
  const pending = loader(refs).finally(() => inFlightBatches.delete(key))
  inFlightBatches.set(key, pending)
  return pending
}

export async function hydrateToolActivitiesOnDemand(
  activities: readonly ToolActivity[],
  loader: ToolActivityDetailLoader = defaultLoader
): Promise<ToolActivity[]> {
  const refs = activities
    .map(detailRefFor)
    .filter((ref): ref is ToolActivityDetailRef => Boolean(ref))
  if (refs.length === 0) return activities as ToolActivity[]
  const details = new Map<string, ToolActivity>()
  for (let offset = 0; offset < refs.length; offset += TOOL_DETAIL_HYDRATION_BATCH_SIZE) {
    const batch = refs.slice(offset, offset + TOOL_DETAIL_HYDRATION_BATCH_SIZE)
    for (const hydrated of await loadBatchOnce(batch, loader)) {
      details.set(detailKey(hydrated.ref), hydrated.activity)
    }
  }
  return mergeHydratedToolActivityDetails(activities, details)
}

const ToolActivityDetailContext = createContext<ReadonlyMap<string, ToolActivity>>(new Map())

function useToolActivityDetailState(activities: readonly ToolActivity[]): {
  activities: ToolActivity[]
  details: ReadonlyMap<string, ToolActivity>
} {
  const inherited = useContext(ToolActivityDetailContext)
  const [local, setLocal] = useState<ReadonlyMap<string, ToolActivity>>(() => new Map())
  const refs = useMemo(
    () =>
      activities
        .map(detailRefFor)
        .filter((ref): ref is ToolActivityDetailRef => Boolean(ref))
        .filter((ref) => !inherited.has(detailKey(ref)) && !local.has(detailKey(ref))),
    [activities, inherited, local]
  )
  const requestKey = refs.map(detailKey).join('|')

  useEffect(() => {
    if (refs.length === 0) return
    let cancelled = false
    void (async () => {
      const next = new Map<string, ToolActivity>()
      for (let offset = 0; offset < refs.length; offset += TOOL_DETAIL_HYDRATION_BATCH_SIZE) {
        const batch = refs.slice(offset, offset + TOOL_DETAIL_HYDRATION_BATCH_SIZE)
        for (const hydrated of await loadBatchOnce(batch, defaultLoader)) {
          next.set(detailKey(hydrated.ref), hydrated.activity)
        }
      }
      if (cancelled || next.size === 0) return
      setLocal((current) => new Map([...current, ...next]))
    })().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [requestKey])

  const details = useMemo(
    () => (local.size === 0 ? inherited : new Map([...inherited, ...local])),
    [inherited, local]
  )
  return {
    activities: useMemo(
      () => mergeHydratedToolActivityDetails(activities, details),
      [activities, details]
    ),
    details
  }
}

export function useHydratedToolActivities(activities: readonly ToolActivity[]): ToolActivity[] {
  return useToolActivityDetailState(activities).activities
}

export function ToolActivityDetailHydrationBoundary({
  activities,
  children
}: {
  activities: readonly ToolActivity[]
  children: (hydrated: ToolActivity[]) => ReactNode
}): ReactElement {
  const state = useToolActivityDetailState(activities)
  return createElement(
    ToolActivityDetailContext.Provider,
    { value: state.details },
    children(state.activities)
  )
}
