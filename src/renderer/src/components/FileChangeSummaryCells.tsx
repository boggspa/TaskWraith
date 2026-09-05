import type { ReactElement } from 'react'
import type { DiffFileSummary, DiffFileSummaryOwner } from '../../../main/store/types'
import { getProviderLabel } from '../lib/providerLabels'
import { ProviderBrandLogo } from './icons/ProviderBrandLogo'

export function fileChangeOwnerLabel(owner: DiffFileSummaryOwner): string {
  if (owner.role) return owner.role
  if (owner.provider) return getProviderLabel(owner.provider)
  return 'Agent'
}

export function fileChangeOwnerTitle(owner: DiffFileSummaryOwner, order?: number): string {
  const provider = owner.provider ? getProviderLabel(owner.provider) : ''
  const role = owner.role || ''
  const label = provider && role ? `${provider} / ${role}` : role || provider || 'Agent'
  return order ? `#${order} ${label}` : label
}

export function normalizeFileChangeOwners(
  owners: DiffFileSummary['owners'] | undefined
): DiffFileSummaryOwner[] {
  if (!Array.isArray(owners)) return []
  return owners.filter((owner) => owner && (owner.provider || owner.participantId || owner.role))
}

export function FileChangeOwnerCell({
  owners
}: {
  owners?: DiffFileSummary['owners']
}): ReactElement {
  const normalizedOwners = normalizeFileChangeOwners(owners)
  if (normalizedOwners.length === 0) {
    return <span className="file-change-summary-owner is-empty" aria-hidden="true" />
  }
  if (normalizedOwners.length === 1) {
    const owner = normalizedOwners[0]
    return (
      <span className="file-change-summary-owner" title={fileChangeOwnerTitle(owner)}>
        {owner.provider && (
          <span className={`file-change-summary-owner-icon provider-${owner.provider}`} aria-hidden>
            <ProviderBrandLogo provider={owner.provider} />
          </span>
        )}
        <span className="file-change-summary-owner-label">{fileChangeOwnerLabel(owner)}</span>
      </span>
    )
  }
  return (
    <span className="file-change-summary-owner is-multiple" aria-label="File editors">
      {normalizedOwners.map((owner, index) => {
        const order = owner.order ?? index + 1
        return (
          <span
            className="file-change-summary-owner-chip"
            key={`${owner.participantId || owner.provider || owner.role || 'owner'}-${index}`}
            title={fileChangeOwnerTitle(owner, order)}
          >
            {owner.provider && (
              <span
                className={`file-change-summary-owner-icon provider-${owner.provider}`}
                aria-hidden
              >
                <ProviderBrandLogo provider={owner.provider} />
              </span>
            )}
            <span className="file-change-summary-owner-index">#{order}</span>
          </span>
        )
      })}
    </span>
  )
}

const FILE_CHANGE_PATH_LABEL_MAX = 44

export function truncateFilePathFromHead(path: string): string {
  if (path.length <= FILE_CHANGE_PATH_LABEL_MAX) return path
  return `...${path.slice(-(FILE_CHANGE_PATH_LABEL_MAX - 3))}`
}

export function filePathTailSegments(path: string): string {
  const raw = typeof path === 'string' ? path : ''
  if (!raw) return ''
  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 2) return truncateFilePathFromHead(raw)
  return truncateFilePathFromHead(`.../${segments.slice(-2).join('/')}`)
}

export function FileChangePathCell({ path }: { path: string }): ReactElement {
  return (
    <span className="file-change-summary-path" title={path}>
      <span className="file-change-summary-path-head" aria-hidden="true">
        {path}
      </span>
      <span className="file-change-summary-path-tail">{filePathTailSegments(path)}</span>
    </span>
  )
}
