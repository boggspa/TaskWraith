import { buildGreeting } from '../../../shared/greeting'

type WelcomeHeadingCopy = {
  beforeWorkspace: string
  workspaceName: string
  afterWorkspace: string
}

export type WelcomeCopy = {
  heading: WelcomeHeadingCopy
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
  diffCount: number
}

export const buildWelcomeCopy = (context: WelcomeCopyContext): WelcomeCopy => {
  // General (global) chats open on a personal time-of-day greeting
  // ("Good morning, What's on your mind Chris?" / "..., What's on your mind?").
  // The ENTIRE greeting goes in the workspace-name-glow span so the whole line
  // carries the provider-hue glow (no plain before/after segments). The
  // welcome hero is heading-only in every variant — there is no subheading.
  const heading: WelcomeHeadingCopy = context.isGlobalChat
    ? {
        beforeWorkspace: '',
        workspaceName: buildGreeting(context.nowHour ?? 12, context.userName),
        afterWorkspace: ''
      }
    : {
        // 1.0.6-CRUX25 — keep the greeting simple + universal:
        // "New <Provider> thread for <Workspace>."
        beforeWorkspace: `New ${context.providerLabel} thread for `,
        workspaceName: context.workspaceName,
        afterWorkspace: '.'
      }

  return {
    heading
  }
}
