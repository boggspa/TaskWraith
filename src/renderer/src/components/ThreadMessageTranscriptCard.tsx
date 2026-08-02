/** Inline transcript adapter for durable peer-message projection rows. */

import type { ChatMessage } from '../../../main/store/types'
import { ThreadMessageInboxCard } from './ThreadMessageInboxCard'
import { threadMessageCardInputFromTranscriptMessage } from './ThreadMessageTranscriptCardModel'

interface ThreadMessageTranscriptCardProps {
  message: ChatMessage
}

export function ThreadMessageTranscriptCard({ message }: ThreadMessageTranscriptCardProps) {
  return <ThreadMessageInboxCard message={threadMessageCardInputFromTranscriptMessage(message)} />
}
