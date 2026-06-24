type WelcomeHeadingCopy = {
  beforeWorkspace: string
  workspaceName: string
  afterWorkspace: string
}

export type WelcomeStarterIntent =
  | 'explore'
  | 'review'
  | 'plan'
  | 'implement'
  | 'debug'
  | 'test'
  | 'schedule'
  | 'global'
export type WelcomeStarter = {
  id: string
  label: string
  description: string
  prompt: string
  intent: WelcomeStarterIntent
}
export type WelcomeCopy = {
  heading: WelcomeHeadingCopy
  subheading: string
  starters: WelcomeStarter[]
}
export type WelcomeCopyContext = {
  workspaceName: string
  providerLabel: string
  permissionModeLabel: string
  isGlobalChat: boolean
  hasDiff: boolean
  diffCount: number
  scheduledTaskCount: number
  lastRunStatus?: string
}

const pluralize = (count: number, singular: string, plural: string = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`

const welcomeContextLine = (context: WelcomeCopyContext): string =>
  `Current GUI context: ${context.providerLabel}, ${context.permissionModeLabel}.`

const buildWorkspaceOrientationPrompt = (context: WelcomeCopyContext): string =>
  [
    `Inspect the ${context.workspaceName} workspace and give me a concise orientation.`,
    welcomeContextLine(context),
    '',
    'Cover:',
    '- what this app appears to do',
    '- the main frontend, backend, and process boundaries',
    '- the files or directories I should understand first',
    '- the riskiest or most complex areas',
    '- the best first task to improve it',
    '',
    'Do not edit files yet.'
  ].join('\n')

const buildDiffReviewPrompt = (context: WelcomeCopyContext): string =>
  [
    `Review the current uncommitted changes in ${context.workspaceName}.`,
    welcomeContextLine(context),
    '',
    'Use read-only inspection first. Check git status, staged and unstaged diffs, and nearby code when needed.',
    '',
    'Return findings first, ordered by severity. For each finding include file/location, issue, impact, and a concrete suggested fix. If there are no findings, say so explicitly and mention residual risks or missing tests.',
    '',
    'Do not edit files, stage files, commit files, or run formatters.'
  ].join('\n')

const buildImplementationPlanPrompt = (context: WelcomeCopyContext): string =>
  [
    `Make a scoped implementation plan for the next useful change in ${context.workspaceName}.`,
    welcomeContextLine(context),
    '',
    'First inspect only enough code to understand the path. Then give:',
    '- the smallest valuable target',
    '- the files likely involved',
    '- the risks and assumptions',
    '- the acceptance checks',
    '- the exact first edit you would make',
    '',
    'Do not edit files until the plan is clear.'
  ].join('\n')

const buildFocusedImplementationPrompt = (context: WelcomeCopyContext): string =>
  [
    `Find and implement the smallest high-impact improvement in ${context.workspaceName}.`,
    welcomeContextLine(context),
    '',
    'Before editing, state the target and why it is the right size. Keep changes tightly scoped, follow existing code patterns, and avoid unrelated refactors.',
    '',
    'After editing, run the narrowest relevant validation and summarize what changed, what was checked, and any remaining risk.'
  ].join('\n')

const buildTestGapPrompt = (context: WelcomeCopyContext): string =>
  [
    `Find the narrowest useful test or validation gap in ${context.workspaceName}.`,
    welcomeContextLine(context),
    '',
    'Inspect existing tests and recent code paths. Recommend one focused check, then either add it or explain why a different validation is more appropriate.',
    '',
    'Keep the change small and run the relevant test command if available.'
  ].join('\n')

const buildFailureDebugPrompt = (context: WelcomeCopyContext): string =>
  [
    `Investigate the last failed ${context.providerLabel} run in this thread.`,
    welcomeContextLine(context),
    '',
    'Use the available transcript, raw logs, and workspace state to identify the failing path. Then give:',
    '- the likely root cause',
    '- the smallest safe fix',
    '- the validation command or manual check',
    '- any risk before editing',
    '',
    'Do not edit files until the failure path is clear.'
  ].join('\n')

const buildContinueSafelyPrompt = (context: WelcomeCopyContext): string =>
  [
    `Continue work in ${context.workspaceName} without losing the current state.`,
    welcomeContextLine(context),
    '',
    'Start by checking the current diff and recent run context. Then propose the next single edit, the reason for it, and the validation check that should follow.',
    '',
    'Do not make broad cleanup changes.'
  ].join('\n')

const buildScheduledWorkPrompt = (context: WelcomeCopyContext): string =>
  [
    `Review the pending scheduled work for ${context.workspaceName}.`,
    welcomeContextLine(context),
    '',
    'Summarize what appears queued or due, identify any conflicts or stale assumptions, and recommend the next action. If a scheduled run should be adjusted, explain the change before making it.'
  ].join('\n')

const buildGlobalPlanningPrompt = (context: WelcomeCopyContext): string =>
  [
    'Help me plan across my coding work from this global chat.',
    welcomeContextLine(context),
    '',
    'Ask for missing context only if necessary. Otherwise, help me choose one concrete next action, the workspace it belongs in, and the first check that would prove progress.'
  ].join('\n')

const buildProviderSetupPrompt = (context: WelcomeCopyContext): string =>
  [
    `Check whether the current ${context.providerLabel} setup is ready for productive work.`,
    welcomeContextLine(context),
    '',
    'Look for obvious provider, model, permission, or workspace trust issues visible from this app state. Recommend the smallest setup fix before suggesting any coding task.'
  ].join('\n')

const buildGlobalTaskPlanPrompt = (context: WelcomeCopyContext): string =>
  [
    'Help me turn a broad coding goal into a workspace-specific implementation plan.',
    welcomeContextLine(context),
    '',
    'Start by identifying the missing context you need. Then produce:',
    '- the workspace or repo this should happen in',
    '- the smallest useful target',
    '- likely files or systems involved',
    '- risks and assumptions',
    '- acceptance checks before implementation starts'
  ].join('\n')

const buildWelcomeStarters = (context: WelcomeCopyContext): WelcomeStarter[] => {
  if (context.isGlobalChat) {
    return [
      {
        id: 'global-plan',
        label: 'Choose next action',
        description: 'Turn broad context into one concrete coding step.',
        prompt: buildGlobalPlanningPrompt(context),
        intent: 'global'
      },
      {
        id: 'provider-setup',
        label: 'Check setup',
        description: 'Review provider, model, permission, and trust readiness.',
        prompt: buildProviderSetupPrompt(context),
        intent: 'global'
      },
      {
        id: 'implementation-plan',
        label: 'Plan workspace task',
        description: 'Turn a broad goal into a scoped repo plan.',
        prompt: buildGlobalTaskPlanPrompt(context),
        intent: 'plan'
      }
    ]
  }

  if (context.lastRunStatus === 'failed') {
    return [
      {
        id: 'debug-failure',
        label: 'Debug failure',
        description: 'Find the failing path before touching files.',
        prompt: buildFailureDebugPrompt(context),
        intent: 'debug'
      },
      {
        id: 'review-changes',
        label: 'Review changes',
        description: 'Read-only diff review with findings first.',
        prompt: buildDiffReviewPrompt(context),
        intent: 'review'
      },
      {
        id: 'continue-safely',
        label: 'Continue safely',
        description: 'Pick one next edit and one validation check.',
        prompt: buildContinueSafelyPrompt(context),
        intent: 'plan'
      }
    ]
  }

  if (context.hasDiff) {
    return [
      {
        id: 'review-changes',
        label: 'Review changes',
        description: `Audit ${context.diffCount > 0 ? pluralize(context.diffCount, 'changed file') : 'the current diff'} before editing.`,
        prompt: buildDiffReviewPrompt(context),
        intent: 'review'
      },
      {
        id: 'continue-safely',
        label: 'Continue safely',
        description: 'Use the current diff to choose the next single edit.',
        prompt: buildContinueSafelyPrompt(context),
        intent: 'plan'
      },
      {
        id: 'test-gap',
        label: 'Find test gap',
        description: 'Add or recommend the narrowest useful validation.',
        prompt: buildTestGapPrompt(context),
        intent: 'test'
      }
    ]
  }

  if (context.scheduledTaskCount > 0) {
    return [
      {
        id: 'scheduled-work',
        label: 'Review schedule',
        description: `Check ${pluralize(context.scheduledTaskCount, 'pending run')} for stale assumptions.`,
        prompt: buildScheduledWorkPrompt(context),
        intent: 'schedule'
      },
      {
        id: 'implementation-plan',
        label: 'Plan a change',
        description: 'Define target, files, risks, and acceptance checks.',
        prompt: buildImplementationPlanPrompt(context),
        intent: 'plan'
      },
      {
        id: 'map-project',
        label: 'Map project',
        description: 'Orient around structure, risk, and best starting point.',
        prompt: buildWorkspaceOrientationPrompt(context),
        intent: 'explore'
      }
    ]
  }

  return [
    {
      id: 'map-project',
      label: 'Map project',
      description: 'Orient around structure, risk, and best starting point.',
      prompt: buildWorkspaceOrientationPrompt(context),
      intent: 'explore'
    },
    {
      id: 'implementation-plan',
      label: 'Plan a change',
      description: 'Define target, files, risks, and acceptance checks.',
      prompt: buildImplementationPlanPrompt(context),
      intent: 'plan'
    },
    {
      id: 'focused-implementation',
      label: 'Make improvement',
      description: 'Find one small valuable edit and verify it.',
      prompt: buildFocusedImplementationPrompt(context),
      intent: 'implement'
    }
  ]
}

export const buildWelcomeCopy = (context: WelcomeCopyContext): WelcomeCopy => {
  const heading: WelcomeHeadingCopy = context.isGlobalChat
    ? {
        beforeWorkspace: `New ${context.providerLabel} `,
        // 1.0.4-AS6 — capitalise as a proper noun. Pre-AS6 read
        // "New Claude global chat." which felt sentence-case in the
        // middle of a Title-Cased heading; the workspace-name slot
        // is bold/glow-styled like the workspace name on
        // workspace-bound chats and reads naturally as Title Case.
        workspaceName: 'General Chat',
        afterWorkspace: '.'
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
    ? 'A general chat for broad planning, setup checks, or choosing the right folder to work in.'
    : context.lastRunStatus === 'failed'
      ? 'Start by narrowing the failure path, then make one fix and verify it.'
      : context.hasDiff
        ? 'Review the current state or choose the next safe edit before adding more changes.'
        : context.scheduledTaskCount > 0
          ? 'Pending scheduled work exists. Check assumptions before starting a new run.'
          : `Pick a starter to place a complete ${context.providerLabel} prompt in the composer.`

  return {
    heading,
    subheading,
    starters: buildWelcomeStarters(context)
  }
}
