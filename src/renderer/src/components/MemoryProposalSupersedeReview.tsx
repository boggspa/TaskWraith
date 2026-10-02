import React, { useState } from 'react'
import type { MemoryProposal, MemoryProposalPack } from '../../../main/store/types'

export interface SupersedeReceipt {
  ok: boolean
  blocked?: string
  predecessorPack?: MemoryProposalPack
  successorPack?: MemoryProposalPack
}

export function verifiedSupersedeReceipt(
  result: SupersedeReceipt,
  packId: string,
  predecessorId: string,
  successorId: string
): boolean {
  const old = result.predecessorPack?.proposals.find((item) => item.id === predecessorId)
  const next = result.successorPack?.proposals.find((item) => item.id === successorId)
  return (
    result.ok &&
    result.predecessorPack?.id === packId &&
    result.successorPack?.id === packId &&
    old?.status === 'superseded' &&
    old.supersededById === successorId &&
    next?.supersedesId === predecessorId &&
    (next.status === 'proposed' || next.status === 'approved')
  )
}

export function supersedeCandidates(
  pack: MemoryProposalPack,
  successor: MemoryProposal
): MemoryProposal[] {
  if (
    !pack.workspaceId ||
    !['proposed', 'approved'].includes(successor.status) ||
    successor.supersedesId ||
    successor.supersededById
  )
    return []
  return pack.proposals.filter(
    (item) =>
      item.id !== successor.id &&
      ['proposed', 'approved'].includes(item.status) &&
      !item.supersedesId &&
      !item.supersededById
  )
}

export function MemoryProposalSupersedeReview({
  pack,
  successor,
  onSupersede,
  onCommitted
}: {
  pack: MemoryProposalPack
  successor: MemoryProposal
  onSupersede: (
    packId: string,
    successorId: string,
    predecessorId: string
  ) => Promise<SupersedeReceipt>
  onCommitted: (pack: MemoryProposalPack) => void
}): React.JSX.Element | null {
  const [selectedId, setSelectedId] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const candidates = supersedeCandidates(pack, successor)
  const predecessor = candidates.find((item) => item.id === selectedId)
  if (!candidates.length) return null
  const confirm = async (): Promise<void> => {
    if (!predecessor || pending) return
    setPending(true)
    setNotice('')
    try {
      const result = await onSupersede(pack.id, successor.id, predecessor.id)
      if (
        !verifiedSupersedeReceipt(result, pack.id, predecessor.id, successor.id) ||
        result.successorPack?.workspaceId !== pack.workspaceId ||
        result.predecessorPack?.workspaceId !== pack.workspaceId ||
        result.successorPack?.proposals.find((item) => item.id === successor.id)?.status !==
          successor.status
      ) {
        setNotice(result.blocked || 'Supersede could not be confirmed. Refresh before retrying.')
        return
      }
      setNotice('Earlier proposal superseded; successor keeps its current status.')
      onCommitted(result.successorPack!)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <section aria-label="Supersede an earlier proposal">
      <label>
        Supersede an earlier proposal{' '}
        <select
          value={selectedId}
          disabled={pending}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          <option value="">Choose an earlier proposal</option>
          {candidates.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} ({item.status})
            </option>
          ))}
        </select>
      </label>
      {predecessor && (
        <div>
          <p>Pack: {pack.id}</p>
          {[predecessor, successor].map((item) => (
            <article key={item.id}>
              <strong>{item.title}</strong>
              <p>
                {item.id} — {item.status}
              </p>
              <p>{item.lesson}</p>
              {item.evidenceRefs.map((ref, index) => (
                <p key={index}>{ref.summary}</p>
              ))}
            </article>
          ))}
          <p>
            This replaces the earlier approval or proposal with Superseded. The successor keeps its
            current status. Applying remains a separate action.
          </p>
          <button type="button" disabled={pending} onClick={() => void confirm()}>
            {pending ? 'Confirming…' : 'Confirm supersede'}
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
