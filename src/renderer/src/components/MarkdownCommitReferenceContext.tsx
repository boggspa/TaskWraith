import { createContext, useContext, useMemo } from 'react'
import type { TraceableCommitIndex } from '../lib/traceableCommitReferences'

export interface MarkdownCommitReferenceContextValue {
  workspacePath: string
  chatId?: string
  /** Test/composition override; production hash tokens resolve from the store. */
  index?: TraceableCommitIndex
}

export const MarkdownCommitReferenceContext =
  createContext<MarkdownCommitReferenceContextValue | null>(null)

export function useMarkdownCommitReferenceValue({
  workspacePath,
  chatId
}: {
  workspacePath?: string
  chatId?: string
}): MarkdownCommitReferenceContextValue | null {
  const inherited = useContext(MarkdownCommitReferenceContext)
  const local = useMemo<MarkdownCommitReferenceContextValue | null>(() => {
    return workspacePath ? { workspacePath, chatId } : null
  }, [chatId, workspacePath])

  return local ?? inherited
}
