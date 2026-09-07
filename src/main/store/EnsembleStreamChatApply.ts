/**
 * Identity-preserving applies for the live ensemble stream flush.
 *
 * A stream tick must not allocate a new `runs` or `participants` array when
 * every item is the same reference, and must not rebuild the ensemble wrapper
 * when only one seat's cheap fields moved. The mutation deriver short-circuits
 * on `Object.is`; a fresh array of the same seats re-opens a 437-run walk.
 */

export function mapPreserveIdentity<T>(
  items: readonly T[],
  mapItem: (item: T, index: number) => T
): T[] {
  let changed = false
  const next = items.map((item, index) => {
    const mapped = mapItem(item, index)
    if (!Object.is(mapped, item)) changed = true
    return mapped
  })
  return changed ? next : (items as T[])
}

export function patchIdentityList<T extends { id: string }>(
  items: readonly T[],
  id: string,
  patch: (item: T) => T
): T[] {
  return mapPreserveIdentity(items, (item) => (item.id === id ? patch(item) : item))
}
