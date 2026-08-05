/** Inline transcript adapter for durable peer-message projection rows. */

import type { ChatMessage } from '../../../main/store/types'
import { ThreadMessageInboxCard } from './ThreadMessageInboxCard'
import { threadMessageCardInputFromTranscriptMessage } from './ThreadMessageTranscriptCardModel'

interface ThreadMessageTranscriptCardProps {
  message: ChatMessage
  /** Opens the sending thread; absent renders the name as inert text. */
  onOpenSenderThread?: (chatId: string) => void
}

export function ThreadMessageTranscriptCard({
  message,
  onOpenSenderThread
}: ThreadMessageTranscriptCardProps) {
  return (
    <ThreadMessageInboxCard
      message={threadMessageCardInputFromTranscriptMessage(message)}
      onOpenSenderThread={onOpenSenderThread}
    />
  )
}
