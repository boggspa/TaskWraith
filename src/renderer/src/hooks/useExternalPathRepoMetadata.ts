/*
 * useExternalPathRepoMetadata — debounced/cached hook that probes each
 * external-path grant for its git repo status (isRepo, repoRoot, branch).
 *
 * Slice 2 of the external-path-redesign arc. Calls
 * `window.api.probeExternalPath` once per unique grant path; caches the
 * result by path so repeat renders are free; revalidates only when the
 * grant list mutates. The probe result drives the new stacked above-rows
 * (slice 3) — each row reads `repoMetadata[grant.id]` to decide whether
 * to render branch + diff + Create-PR or just a basename.
 *
 * Repo metadata is NEVER persisted to disk — branch can change while the
 * grant is alive (user checks out another branch in the external repo),
 * so we always re-derive at render time. Grants stay as the durable
 * persistence layer.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExternalPathGrant } from '../../../main/store/types'
import type { ExternalPathGitMetadata } from '../lib/ExternalPathRepoDetect'

interface RepoMetadataMap {
  [grantId: string]: ExternalPathGitMetadata | null
}

interface RepoMetadataByPath {
  [path: string]: ExternalPathGitMetadata | null
}

function repoMetadataMapsEqual(a: RepoMetadataByPath, b: RepoMetadataByPath): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key])
}

/**
 * Probe each grant's path and return a metadata map keyed by path.
 * Re-probes when a grant is added/removed. Already-probed paths are
 * served from cache.
 *
 * Returns `null` for paths that don't exist or aren't repos — the
 * descriptor helper handles the null branch gracefully.
 */
export function useExternalPathRepoMetadataByPath(grants: ExternalPathGrant[]): RepoMetadataByPath {
  const [metadata, setMetadata] = useState<RepoMetadataByPath>({})
  const cacheRef = useRef<Map<string, ExternalPathGitMetadata | null>>(new Map())
  const pathsKey = [...new Set(grants.map((grant) => grant.path))].sort().join('\u0000')

  useEffect(() => {
    let cancelled = false
    const paths = pathsKey ? pathsKey.split('\u0000') : []
    const commitMetadata = (next: RepoMetadataByPath): void => {
      setMetadata((current) => (repoMetadataMapsEqual(current, next) ? current : next))
    }

    async function refresh() {
      const next: RepoMetadataByPath = {}
      const pending: string[] = []
      for (const path of paths) {
        const cached = cacheRef.current.get(path)
        if (cached !== undefined) {
          next[path] = cached
        } else {
          pending.push(path)
        }
      }
      // Render with whatever we already have cached, then top-up
      // asynchronously for newly-added grants.
      if (Object.keys(next).length > 0 || pending.length === 0) {
        if (!cancelled) commitMetadata(next)
      }
      if (pending.length === 0) return

      const probeResults = await Promise.all(
        pending.map(async (path) => {
          try {
            const result = await window.api.probeExternalPath(path)
            return { path, result: result || null }
          } catch {
            return { path, result: null }
          }
        })
      )
      if (cancelled) return
      for (const { path, result } of probeResults) {
        cacheRef.current.set(path, result)
      }
      // Rebuild the full map from cache after async probes settle.
      const settled: RepoMetadataByPath = {}
      for (const path of paths) {
        const cached = cacheRef.current.get(path)
        settled[path] = cached !== undefined ? cached : null
      }
      commitMetadata(settled)
    }

    void refresh()
    return () => {
      cancelled = true
    }
  }, [pathsKey])

  return metadata
}

/**
 * Backward-compatible grant-id view used by composer callers. The underlying
 * probe/cache is path-keyed so multiple visible Multiview chats can safely
 * share probe results without grant-id collisions or focused-chat state.
 */
export function useExternalPathRepoMetadata(grants: ExternalPathGrant[]): RepoMetadataMap {
  const byPath = useExternalPathRepoMetadataByPath(grants)
  return useMemo(
    () =>
      Object.fromEntries(
        grants.map((grant) => [grant.id, byPath[grant.path] ?? null])
      ) as RepoMetadataMap,
    [byPath, grants]
  )
}
