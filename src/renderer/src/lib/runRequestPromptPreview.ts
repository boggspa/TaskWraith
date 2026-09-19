import type { ProjectReferenceContextSelection } from '../../../shared/projectReferenceContext'
import { attachmentSummary } from './imageAttachments'
import { discordContextSelectionSummary } from './queuedMessageRows'
import type { QueuedRunRequest } from './runRequestTypes'

/**
 * The request fields that determine what a run's prompt looks like to the user.
 *
 * `displayPrompt` is a renderer-facing preview and may deliberately differ from
 * `prompt`, which is what the provider actually receives. Nothing here may be
 * treated as the delivered text.
 */
export type RunRequestPromptSource = Pick<
  QueuedRunRequest,
  | 'prompt'
  | 'displayPrompt'
  | 'imageAttachments'
  | 'projectReferenceContextSelection'
  | 'discordContextSelection'
>

export const projectReferenceContextSummary = (
  selection: ProjectReferenceContextSelection | null | undefined
): string =>
  selection
    ? `${selection.referenceIds.length} Project reference${selection.referenceIds.length === 1 ? '' : 's'}`
    : ''

export const runRequestDisplayPrompt = (
  request: RunRequestPromptSource,
  finalPrompt: string
): string => {
  if (request.displayPrompt?.trim()) return request.displayPrompt
  if (request.prompt.trim()) return finalPrompt
  return (
    attachmentSummary(request.imageAttachments) ||
    projectReferenceContextSummary(request.projectReferenceContextSelection) ||
    discordContextSelectionSummary(request.discordContextSelection) ||
    finalPrompt
  )
}

/**
 * The text shown on a queued/steered transcript row.
 *
 * Falls back through `displayPrompt` -> `prompt` -> attachment/project-reference/
 * Discord summaries. Each candidate is considered on its TRIMMED value: a
 * whitespace-only `displayPrompt` carries no content and must not suppress a
 * perfectly good `prompt`. An empty result here is not cosmetic — a transcript
 * row whose content trims to empty is dropped from provider history by
 * `eligibleConversationMessages`, so the steer would be visible to the user and
 * invisible to the model.
 */
export const runRequestPromptPreview = (request: RunRequestPromptSource): string => {
  const text = request.displayPrompt?.trim() || request.prompt?.trim() || ''
  return (
    text ||
    attachmentSummary(request.imageAttachments) ||
    projectReferenceContextSummary(request.projectReferenceContextSelection) ||
    discordContextSelectionSummary(request.discordContextSelection)
  )
}
