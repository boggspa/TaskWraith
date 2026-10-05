/**
 * The queue is a pure shared helper. Main consumes it too, and the architecture
 * guard forbids a new main -> renderer runtime edge, so the implementation
 * lives in src/shared and this path only re-exports it.
 */
export {
  MAX_SUPERSEDED_INTENT_HANDLES,
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveOwnershipPort,
  type ChatSaveIntent,
  type ChatSaveIntentHandle,
  type ChatSaveIntentHead
} from '../../../shared/chatSaveIntentQueue'
