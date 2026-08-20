/**
 * The first-run Ensemble sample is deliberately an inspection-only prompt. It gives
 * a new user an answer to “what should I do to test this?” without turning
 * onboarding into an implicit code change or an unattended run.
 *
 * Keep this prompt provider-agnostic and deterministic. It is copied into the
 * user's composer, so it must not contain a workspace path, a provider name,
 * credentials, or assumptions about the repository's language.
 */

export const FIRST_RUN_ENSEMBLE_TASK_ID = 'first-run-workspace-review-v1' as const

export interface FirstRunEnsembleTask {
  id: typeof FIRST_RUN_ENSEMBLE_TASK_ID
  title: string
  summary: string
  prompt: string
  recommendedSetup: readonly string[]
  expectedSignals: readonly string[]
}

const FIRST_RUN_PROMPT_LINES = [
  '[TaskWraith first-run Ensemble sample]',
  '',
  'Goal: give me a concise, evidence-backed review of the current workspace and one safe next step. Treat this as a read-only exercise: do not edit, create, delete, commit, install, publish, or send anything, and do not ask for secrets or external access.',
  '',
  'Work as a visible panel, not as several independent solo chats. The Boss/lead should open by assigning distinct lenses to the available seats and naming the hand-offs. If fewer than three seats are enabled, say so and run the available lenses as separate passes; never pretend a missing seat contributed.',
  '',
  'Use these lenses (adapt the names to the current roster):',
  '1. Explorer — map the relevant entry points, tests, and user-visible flow. Cite paths or symbols, but do not dump a raw filesystem path as the deliverable.',
  '2. Risk reviewer — independently look for correctness, safety, privacy, and maintenance risks in the same flow. Call out what evidence is missing.',
  '3. Delivery planner — propose the smallest useful next step, its acceptance checks, and a fallback if the evidence is inconclusive.',
  '4. Chair/reviewer — compare the peer findings, resolve disagreements, and return a ranked verdict. The verdict must cite at least two peer findings and say why the winning next step beats the alternatives.',
  '',
  'Keep each contribution short. Announce when you have yielded to the next lens, and do not repeat a conclusion just because another seat already made it. End with exactly these headings:',
  '## Seat contributions',
  '## Ranked verdict',
  '## Smallest safe next step',
  '## Evidence still missing',
  '',
  'The final answer should be useful to a human deciding what to do next, while making the collaboration, role boundaries, review, and evidence visible in the transcript.'
] as const

export const FIRST_RUN_ENSEMBLE_TASK: FirstRunEnsembleTask = {
  id: FIRST_RUN_ENSEMBLE_TASK_ID,
  title: 'Run a governed workspace review',
  summary:
    'A short inspection panel: seats use different lenses, hand off evidence, and a reviewer ranks the next step.',
  prompt: FIRST_RUN_PROMPT_LINES.join('\n'),
  recommendedSetup: [
    'Use an Ensemble with three or four enabled seats.',
    'Choose Turn mode so the hand-offs remain easy to follow.',
    'Before sending, choose the Read-only permission role for every seat; the copied prompt cannot set permissions.',
    'Run it against a scratch repository or a project you are comfortable inspecting.'
  ],
  expectedSignals: [
    'Named seats announce distinct lenses before working.',
    'Peer findings are handed off instead of silently duplicated.',
    'A reviewer cites at least two peer findings and ranks the options.',
    'The final deliverable is a decision and evidence summary, not a raw path dump.',
    'No file, git, account, or external-service mutation occurs.'
  ]
}

export function getFirstRunEnsembleTaskPrompt(): string {
  return FIRST_RUN_ENSEMBLE_TASK.prompt
}
