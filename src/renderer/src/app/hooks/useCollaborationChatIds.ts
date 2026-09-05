import { useCallback, useEffect, useState } from 'react'

export function useCollaborationChatIds(): Set<string> {
  const [collaboratingChatIds, setCollaboratingChatIds] = useState<Set<string>>(new Set())
  // Full enabled-share list (for the Shares footer popover). Mirrors the Set
  // above but keeps the participant/mode detail the popover renders.
  const refreshCollaborationChatIds = useCallback(() => {
    const channels = window.api.channels
    if (!channels) return
    void channels
      .list()
      .then((result) => {
        if (!result.ok) return
        setCollaboratingChatIds(
          new Set(
            result.value
              .filter((channel) => channel.status === 'active')
              .map((channel) => channel.chatId)
          )
        )
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    refreshCollaborationChatIds()
    return window.api.channels?.onChanged?.(() => refreshCollaborationChatIds())
  }, [refreshCollaborationChatIds])
  return collaboratingChatIds
}
