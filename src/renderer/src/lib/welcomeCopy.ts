import { buildGreeting } from '../../../shared/greeting'

type WelcomeHeadingCopy = {
  beforeWorkspace: string
  workspaceName: string
  afterWorkspace: string
}

export type WelcomeCopy = {
  heading: WelcomeHeadingCopy
  subheading: string
}
export type WelcomeCopyContext = {
  workspaceName: string
  providerLabel: string
  permissionModeLabel: string
  isGlobalChat: boolean
  /** Local hour (0-23) for the General-chat time-of-day greeting. */
  nowHour?: number
  /** Optional display name appended to the General-chat greeting. */
  userName?: string
  hasDiff: boolean
  diffCount: number
  scheduledTaskCount: number
  lastRunStatus?: string
}

export const buildWelcomeCopy = (context: WelcomeCopyContext): WelcomeCopy => {
  // General (global) chats open on a personal time-of-day greeting
  // ("Good morning, What's on your mind Chris?" / "..., What's on your mind?").
  // The ENTIRE greeting goes in the workspace-name-glow span so the whole line
  // carries the provider-hue glow (no plain before/after segments). The subtitle
  // is dropped for General chats (the '' subheading below) — the welcome is
  // intentionally stripped to greeting + composer + notifications.
  const heading: WelcomeHeadingCopy = context.isGlobalChat
    ? {
        beforeWorkspace: '',
        workspaceName: buildGreeting(context.nowHour ?? 12, context.userName),
        afterWorkspace: ''
      }
    : {
        // 1.0.6-CRUX25 — keep the greeting simple + universal:
        // "New <Provider> thread for <Workspace>." The diff-count /
        // failed-run clauses were noisy (e.g. "with 105 changed files
        // ready"); that context still lives in the subheading below.
        beforeWorkspace: `New ${context.providerLabel} thread for `,
        workspaceName: context.workspaceName,
        afterWorkspace: '.'
      }

  const subheading = context.isGlobalChat
    ? ''
    : context.lastRunStatus === 'failed'
      ? 'Start by narrowing the failure path, then make one fix and verify it.'
      : context.hasDiff
        ? 'Review the current state or choose the next safe edit before adding more changes.'
        : context.scheduledTaskCount > 0
          ? 'Pending scheduled work exists. Check assumptions before starting a new run.'
          : `Type a prompt for ${context.providerLabel} to start the thread.`

  return {
    heading,
    subheading
  }
}
