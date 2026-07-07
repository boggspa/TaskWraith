import type { ChatMessage, DiffFileSummary } from '../../../main/store/types'
import type { ImageAttachment } from './imageAttachments'

export const EMPTY_CHAT_MESSAGES: ChatMessage[] = []
export const EMPTY_IMAGE_ATTACHMENTS: ImageAttachment[] = []
export const EMPTY_TRANSCRIPT_FILE_SUMMARIES: DiffFileSummary[] = []

export const NOOP_AGENT_QUESTION_SUBMIT = () => {}
export const NOOP_MESSAGE_ACTION = () => {}
export const NOOP_PLAN_CHOICE_SUBMIT = () => {}
export const NOOP_PROPOSED_PLAN_CUSTOM = () => {}
