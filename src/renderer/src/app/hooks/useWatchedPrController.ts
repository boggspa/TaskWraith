import { useCallback, useEffect, useState } from 'react'

import type { GitPrSummary } from '../../../../main/services/GitService'
import type { ChatRecord } from '../../../../main/store/types'
import type { WatchPrNotifyPayload } from '../../../../main/services/WatchPrPoller'
import type { WatchPollProgress } from '../../../../shared/watchPrPollCycle'
import { buildCiNotice } from '../../lib/ciNotice'
import { stripElectronInvokeErrorFraming } from '../../lib/electronInvokeError'
import { isChatSummaryRecord } from '../../lib/chatRecordMerge'
import {
  watchedPrDescriptorFromGitHubUrl,
  watchedPrDescriptorsMatch
} from '../../lib/watchedPrUi'

interface UseWatchedPrControllerInput {
  currentChat: ChatRecord | null
  workspacePath?: string
  primaryPr: GitPrSummary | null
  primaryPrDisabledReason?: string | null
  disabled?: boolean
  readCachedChat: (chatId: string) => ChatRecord | null
  updateChatLocal: (
    chatId: string,
    updater: (chat: ChatRecord) => ChatRecord
  ) => ChatRecord | null
  applyPersistedChat: (chat: ChatRecord) => void
  setChatPromptDraft: (chatId: string, value: string) => void
}

export interface WatchedPrController {
  isWatching: boolean
  onToggleWatch?: (next: boolean) => void
  disabledReason?: string
  statusMessage?: string
}

export function useWatchedPrController({
  currentChat,
  workspacePath,
  primaryPr,
  primaryPrDisabledReason,
  disabled = false,
  readCachedChat,
  updateChatLocal,
  applyPersistedChat,
  setChatPromptDraft
}: UseWatchedPrControllerInput): WatchedPrController {
  const [progressByChatId, setProgressByChatId] = useState<Record<string, WatchPollProgress>>({})
  const [togglePendingByChatId, setTogglePendingByChatId] = useState<
    Record<string, 'enable' | 'disable'>
  >({})
  const [toggleErrorByChatId, setToggleErrorByChatId] = useState<Record<string, string>>({})

  const handleToggle = useCallback(
    async (next: boolean): Promise<void> => {
      const chatId = currentChat?.appChatId
      if (!currentChat || !chatId || !workspacePath) return

      const descriptor = next
        ? primaryPr
          ? watchedPrDescriptorFromGitHubUrl({ chatId, workspacePath, pr: primaryPr })
          : null
        : null
      if (next && !descriptor) {
        setToggleErrorByChatId((previous) => ({
          ...previous,
          [chatId]: 'This pull request does not have a valid GitHub URL.'
        }))
        return
      }
      if (typeof window.api.githubSetWatchedPr !== 'function') {
        setToggleErrorByChatId((previous) => ({
          ...previous,
          [chatId]: 'PR watching is unavailable in this app build.'
        }))
        return
      }

      setTogglePendingByChatId((previous) => ({
        ...previous,
        [chatId]: next ? 'enable' : 'disable'
      }))
      setToggleErrorByChatId((previous) => {
        const updated = { ...previous }
        delete updated[chatId]
        return updated
      })
      try {
        const result = await window.api.githubSetWatchedPr({
          chatId,
          watchedPr: descriptor
            ? {
                workspacePath: descriptor.workspacePath,
                owner: descriptor.owner,
                repo: descriptor.repo,
                prNumber: descriptor.prNumber
              }
            : null
        })
        if (!result.ok) throw new Error(result.error)
        updateChatLocal(chatId, (source) => {
          const updated = { ...source, updatedAt: Date.now() }
          if (descriptor) updated.watchedPr = descriptor
          else delete updated.watchedPr
          return updated
        })
        if (!descriptor) {
          setProgressByChatId((previous) => {
            const updated = { ...previous }
            delete updated[chatId]
            return updated
          })
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? stripElectronInvokeErrorFraming(error.message)
            : "Couldn't update this thread's PR watch."
        setToggleErrorByChatId((previous) => ({ ...previous, [chatId]: message }))
      } finally {
        setTogglePendingByChatId((previous) => {
          const updated = { ...previous }
          delete updated[chatId]
          return updated
        })
      }
    },
    [currentChat, primaryPr, updateChatLocal, workspacePath]
  )

  const handleNotify = useCallback(
    async (payload: WatchPrNotifyPayload): Promise<void> => {
      const chatId = payload.descriptor.chatId
      let ackError: string | undefined
      try {
        let source = readCachedChat(chatId)
        if (!source || isChatSummaryRecord(source)) {
          source = await window.api.getChat(chatId)
        }
        if (!source || isChatSummaryRecord(source)) {
          throw new Error('The watched thread could not be loaded.')
        }
        if (!watchedPrDescriptorsMatch(source.watchedPr, payload.descriptor)) {
          throw new Error('This thread is no longer watching that pull request.')
        }

        const notice = buildCiNotice(
          payload.pr,
          payload.ci,
          `${payload.descriptor.owner}/${payload.descriptor.repo}`
        )
        if (!notice?.shouldOffer) {
          throw new Error('The pull request no longer has a notify-worthy result.')
        }

        if (source.chatKind === 'ensemble') {
          await window.api.postBlackboardEntry({
            chatId,
            key: notice.key,
            value: notice.detail,
            category: 'ci-status',
            scope: 'chat'
          })
        } else {
          const alreadyRecorded = (source.messages || []).some(
            (message) =>
              message.metadata?.kind === 'ciNotice' &&
              message.metadata?.watchPrSignature === payload.signature
          )
          if (!alreadyRecorded) {
            const updatedChat: ChatRecord = {
              ...source,
              messages: [
                ...(source.messages || []),
                {
                  id: `ci-watch-notice-${chatId}-${Date.now()}`,
                  role: 'system',
                  content: notice.detail,
                  timestamp: new Date().toISOString(),
                  metadata: {
                    kind: 'ciNotice',
                    watchPrSignature: payload.signature
                  }
                }
              ],
              updatedAt: Date.now()
            }
            const saved = await window.api.saveChat(updatedChat)
            applyPersistedChat(saved || updatedChat)
          }
          setChatPromptDraft(chatId, notice.suggestedPrompt)
        }
      } catch (error) {
        ackError =
          error instanceof Error
            ? stripElectronInvokeErrorFraming(error.message)
            : "Couldn't post the CI update to this thread."
      }

      if (typeof window.api.githubWatchPrNotifyAck === 'function') {
        await window.api
          .githubWatchPrNotifyAck({
            chatId,
            signature: payload.signature,
            ok: !ackError,
            ...(ackError ? { error: ackError } : {})
          })
          .catch(() => {})
      }
    },
    [applyPersistedChat, readCachedChat, setChatPromptDraft]
  )

  useEffect(() => {
    const stopNotify =
      typeof window.api.onGitHubWatchPrNotify === 'function'
        ? window.api.onGitHubWatchPrNotify((payload) => {
            void handleNotify(payload)
          })
        : undefined
    const stopProgress =
      typeof window.api.onGitHubWatchPrProgress === 'function'
        ? window.api.onGitHubWatchPrProgress((progress) => {
            setProgressByChatId((previous) => ({
              ...previous,
              [progress.chatId]: progress
            }))
          })
        : undefined
    return () => {
      stopNotify?.()
      stopProgress?.()
    }
  }, [handleNotify])

  const chatId = currentChat?.appChatId || ''
  const isWatching = Boolean(currentChat?.watchedPr)
  const progress = chatId ? progressByChatId[chatId] : undefined
  const pending = chatId ? togglePendingByChatId[chatId] : undefined
  const toggleError = chatId ? toggleErrorByChatId[chatId] : undefined
  const availableDescriptor =
    chatId && workspacePath && primaryPr
      ? watchedPrDescriptorFromGitHubUrl({ chatId, workspacePath, pr: primaryPr })
      : null
  const disabledReason = disabled
    ? undefined
    : !isWatching
      ? primaryPrDisabledReason ||
        (!primaryPr
          ? 'No open pull request to watch.'
          : !availableDescriptor
            ? 'This pull request does not have a valid GitHub URL.'
            : undefined)
      : undefined
  const statusMessage = pending
    ? pending === 'enable'
      ? 'Saving this PR watch…'
      : 'Turning off this PR watch…'
    : toggleError ||
      progress?.failure?.message ||
      (progress?.phase === 'polling'
        ? 'Checking this PR…'
        : progress?.phase === 'notified'
          ? 'This thread was notified about the latest result.'
          : progress?.phase === 'skipped' && isWatching
            ? 'Watching for a new failing or blocked result.'
            : undefined)

  return {
    isWatching: !disabled && isWatching,
    onToggleWatch: !disabled && !pending ? (next) => void handleToggle(next) : undefined,
    disabledReason,
    statusMessage
  }
}
