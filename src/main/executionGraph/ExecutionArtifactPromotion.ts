import type { ProjectReferenceProposalCandidate } from '../../shared/projectReferenceProposal'
import { parseProjectReferenceProposalCandidate } from '../../shared/projectReferenceProposal'
import type { ExecutionArtifactRef, OutputStep, StepAttempt } from './ExecutionGraphModel'

/**
 * Artifact promotion stops at a review intent. This module deliberately has no
 * ProjectReference store dependency and cannot add a catalogue entry.
 */
export interface ExecutionArtifactPromotionIntent {
  readonly schemaVersion: 1
  readonly kind: 'project_reference_proposal'
  readonly disposition: 'review_required'
  readonly projectId: string
  readonly candidate: ProjectReferenceProposalCandidate
  readonly evidence: {
    readonly executionId: string
    readonly outputStepId: string
    readonly outputAttemptId: string
    readonly sourceStepId: string
    readonly sourceAttemptId: string
    readonly artifactId: string
    readonly artifactDigest?: string
    readonly providerRunRef: string
    readonly threadRef: string
    readonly rootChatId: string
  }
}

export type ExecutionArtifactPromotionDiagnosticCode =
  | 'invalid_plan_identity'
  | 'output_step_not_completed'
  | 'promotion_not_requested'
  | 'upstream_attempt_not_completed'
  | 'upstream_result_missing'
  | 'deterministic_result_ineligible'
  | 'non_provider_result_ineligible'
  | 'provider_run_reference_missing'
  | 'provider_run_reference_mismatch'
  | 'thread_identity_missing'
  | 'thread_identity_mismatch'
  | 'deterministic_artifact_ineligible'
  | 'non_provider_artifact_ineligible'
  | 'artifact_evidence_invalid'
  | 'artifact_attempt_mismatch'
  | 'artifact_locator_missing'
  | 'artifact_locator_unsupported'
  | 'artifact_locator_sensitive'
  | 'artifact_candidate_invalid'
  | 'duplicate_candidate'

export interface ExecutionArtifactPromotionDiagnostic {
  readonly code: ExecutionArtifactPromotionDiagnosticCode
  readonly message: string
  readonly sourceStepId?: string
  readonly sourceAttemptId?: string
  readonly artifactId?: string
}

export interface ExecutionArtifactPromotionPlan {
  readonly intents: readonly ExecutionArtifactPromotionIntent[]
  readonly diagnostics: readonly ExecutionArtifactPromotionDiagnostic[]
}

export interface PlanExecutionArtifactPromotionInput {
  readonly executionId: string
  readonly projectId: string
  /** Main-resolved root chat for this execution, never an artifact-supplied value. */
  readonly rootChatId: string
  readonly outputStep: OutputStep
  readonly outputAttempt: StepAttempt
  /** Succeeded attempts on graph predecessors of the OutputStep. */
  readonly upstreamAttempts: readonly StepAttempt[]
}

type LocatorResult =
  | { readonly ok: true; readonly candidate: ProjectReferenceProposalCandidate }
  | {
      readonly ok: false
      readonly code:
        | 'artifact_locator_missing'
        | 'artifact_locator_unsupported'
        | 'artifact_locator_sensitive'
        | 'artifact_candidate_invalid'
      readonly message: string
    }

const SENSITIVE_QUERY_KEY =
  /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|awsaccesskeyid|credential|key|pass(?:word|wd)?|secret|session|sig(?:nature)?|token)(?:$|[_-])/i

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPortableAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  )
}

function hasUnsafeText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true
    }
  }
  return false
}

function sanitizedTitle(value: string): string {
  const sanitized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        codePoint > 0x1f &&
        codePoint !== 0x7f &&
        !(codePoint >= 0x202a && codePoint <= 0x202e) &&
        !(codePoint >= 0x2066 && codePoint <= 0x2069)
      )
    })
    .join('')
    .trim()
  return sanitized.slice(0, 512)
}

function finalPathSegment(locator: string): string {
  const withoutTrailingSeparator = locator.replace(/[\\/]+$/, '')
  const segment = withoutTrailingSeparator.split(/[\\/]/).pop() || ''
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function titleForCandidate(
  candidate: Pick<ProjectReferenceProposalCandidate, 'kind' | 'locator'>,
  outputStep: OutputStep
): string {
  let locatorTitle = ''
  if (candidate.kind === 'url') {
    try {
      locatorTitle = finalPathSegment(new URL(candidate.locator).pathname)
    } catch {
      locatorTitle = ''
    }
  } else {
    locatorTitle = finalPathSegment(candidate.locator)
  }
  return (
    sanitizedTitle(locatorTitle) ||
    sanitizedTitle(outputStep.output.label || '') ||
    (candidate.kind === 'folder' ? 'Output folder' : 'Execution artifact')
  )
}

function fileUrlToPortablePath(value: URL): string | null {
  if (value.username || value.password || value.search || value.hash) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(value.pathname)
  } catch {
    return null
  }
  if (value.hostname && value.hostname !== 'localhost') {
    return `//${value.hostname}${pathname}`
  }
  if (/^\/[a-zA-Z]:\//.test(pathname)) return pathname.slice(1)
  return pathname
}

function candidateFromArtifact(
  artifact: ExecutionArtifactRef,
  outputStep: OutputStep
): LocatorResult {
  if (!nonEmpty(artifact.uri)) {
    return {
      ok: false,
      code: 'artifact_locator_missing',
      message: 'Artifact has no promotable locator.'
    }
  }
  const rawLocator = artifact.uri.trim()
  if (hasUnsafeText(rawLocator)) {
    return {
      ok: false,
      code: 'artifact_candidate_invalid',
      message: 'Artifact locator contains unsafe control text.'
    }
  }

  let kind: ProjectReferenceProposalCandidate['kind']
  let locator: string
  if (isPortableAbsolutePath(rawLocator)) {
    kind = /[\\/]$/.test(rawLocator) ? 'folder' : 'file'
    locator = rawLocator
  } else {
    let parsed: URL
    try {
      parsed = new URL(rawLocator)
    } catch {
      return {
        ok: false,
        code: 'artifact_locator_unsupported',
        message: 'Artifact locator is not an absolute path or an http(s) URL.'
      }
    }
    if (parsed.protocol === 'file:') {
      const portablePath = fileUrlToPortablePath(parsed)
      if (!portablePath || !isPortableAbsolutePath(portablePath)) {
        return {
          ok: false,
          code: 'artifact_locator_unsupported',
          message: 'Artifact file URL cannot be converted to a portable absolute path.'
        }
      }
      kind = /[\\/]$/.test(portablePath) ? 'folder' : 'file'
      locator = portablePath
    } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))
      ) {
        return {
          ok: false,
          code: 'artifact_locator_sensitive',
          // Never echo the URI: this diagnostic is safe to persist and render.
          message: 'Artifact URL contains credential-like material and was redacted from proposals.'
        }
      }
      kind = 'url'
      locator = parsed.toString()
    } else {
      return {
        ok: false,
        code: 'artifact_locator_unsupported',
        message: 'Artifact locator scheme is not eligible for Project reference review.'
      }
    }
  }

  const candidate = parseProjectReferenceProposalCandidate({
    kind,
    locator,
    title: titleForCandidate({ kind, locator }, outputStep)
  })
  return candidate
    ? { ok: true, candidate }
    : {
        ok: false,
        code: 'artifact_candidate_invalid',
        message: 'Artifact locator cannot form a valid Project reference candidate.'
      }
}

function freezePlan(
  intents: ExecutionArtifactPromotionIntent[],
  diagnostics: ExecutionArtifactPromotionDiagnostic[]
): ExecutionArtifactPromotionPlan {
  return Object.freeze({
    intents: Object.freeze(
      intents.map((intent) =>
        Object.freeze({
          ...intent,
          candidate: Object.freeze({ ...intent.candidate }),
          evidence: Object.freeze({ ...intent.evidence })
        })
      )
    ),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })))
  })
}

function attemptDiagnostic(
  attempt: StepAttempt,
  code: ExecutionArtifactPromotionDiagnosticCode,
  message: string,
  artifactId?: string
): ExecutionArtifactPromotionDiagnostic {
  return {
    code,
    message,
    sourceStepId: attempt.stepId,
    sourceAttemptId: attempt.id,
    ...(artifactId ? { artifactId } : {})
  }
}

/**
 * Plans reviewed Project-reference proposals from genuine provider-backed
 * artifacts. The caller may persist these as proposal evidence, but only the
 * existing user-review path may turn one into a ProjectReference.
 */
export function planExecutionArtifactPromotion(
  input: PlanExecutionArtifactPromotionInput
): ExecutionArtifactPromotionPlan {
  const intents: ExecutionArtifactPromotionIntent[] = []
  const diagnostics: ExecutionArtifactPromotionDiagnostic[] = []
  if (!nonEmpty(input.executionId) || !nonEmpty(input.projectId) || !nonEmpty(input.rootChatId)) {
    diagnostics.push({
      code: 'invalid_plan_identity',
      message: 'Execution, Project, and root chat identities are required.'
    })
    return freezePlan(intents, diagnostics)
  }
  if (
    input.outputAttempt.stepId !== input.outputStep.id ||
    input.outputAttempt.state !== 'succeeded'
  ) {
    diagnostics.push({
      code: 'output_step_not_completed',
      message: 'Project reference proposals require a succeeded OutputStep.'
    })
    return freezePlan(intents, diagnostics)
  }
  if (input.outputStep.output.projectReference !== 'propose') {
    diagnostics.push({
      code: 'promotion_not_requested',
      message: 'OutputStep does not request Project reference proposals.'
    })
    return freezePlan(intents, diagnostics)
  }

  const seenCandidates = new Set<string>()
  for (const attempt of input.upstreamAttempts) {
    if (attempt.stepId === input.outputStep.id || attempt.state !== 'succeeded') {
      diagnostics.push(
        attemptDiagnostic(
          attempt,
          'upstream_attempt_not_completed',
          'Only succeeded upstream attempts may propose artifacts.'
        )
      )
      continue
    }
    const result = attempt.result
    if (!result) {
      diagnostics.push(
        attemptDiagnostic(attempt, 'upstream_result_missing', 'Upstream attempt has no result.')
      )
      continue
    }
    if (result.trust === 'deterministic') {
      diagnostics.push(
        attemptDiagnostic(
          attempt,
          'deterministic_result_ineligible',
          'Deterministic results are not evidence of a real provider artifact.'
        )
      )
      continue
    }
    if (result.trust !== 'untrusted_agent_output') {
      diagnostics.push(
        attemptDiagnostic(
          attempt,
          'non_provider_result_ineligible',
          'Only provider-produced results are eligible for artifact proposals.'
        )
      )
      continue
    }
    if (!nonEmpty(attempt.providerRunRef) || !nonEmpty(result.providerRunRef)) {
      diagnostics.push(
        attemptDiagnostic(
          attempt,
          'provider_run_reference_missing',
          'Provider-backed result is missing its durable run reference.'
        )
      )
      continue
    }
    if (attempt.providerRunRef !== result.providerRunRef) {
      diagnostics.push(
        attemptDiagnostic(
          attempt,
          'provider_run_reference_mismatch',
          'Attempt and result provider run references do not match.'
        )
      )
      continue
    }
    if (!nonEmpty(result.threadRef)) {
      diagnostics.push(
        attemptDiagnostic(
          attempt,
          'thread_identity_missing',
          'Provider-backed result is missing its thread identity.'
        )
      )
      continue
    }
    if (result.threadRef !== input.rootChatId) {
      diagnostics.push(
        attemptDiagnostic(
          attempt,
          'thread_identity_mismatch',
          'Result thread is not bound to this execution root chat.'
        )
      )
      continue
    }

    for (const artifact of result.artifactRefs) {
      if (artifact.schemaVersion !== 1 || !nonEmpty(artifact.id)) {
        diagnostics.push(
          attemptDiagnostic(
            attempt,
            'artifact_evidence_invalid',
            'Artifact is missing a valid evidence identity.'
          )
        )
        continue
      }
      if (artifact.createdByAttemptId !== attempt.id) {
        diagnostics.push(
          attemptDiagnostic(
            attempt,
            'artifact_attempt_mismatch',
            'Artifact is not bound to its claimed source attempt.',
            artifact.id
          )
        )
        continue
      }
      if (artifact.trust === 'deterministic') {
        diagnostics.push(
          attemptDiagnostic(
            attempt,
            'deterministic_artifact_ineligible',
            'Deterministic artifacts are not evidence of a real provider artifact.',
            artifact.id
          )
        )
        continue
      }
      if (artifact.trust !== 'untrusted_agent_output') {
        diagnostics.push(
          attemptDiagnostic(
            attempt,
            'non_provider_artifact_ineligible',
            'Only provider-produced artifacts are eligible for review.',
            artifact.id
          )
        )
        continue
      }
      const locatorResult = candidateFromArtifact(artifact, input.outputStep)
      if (!locatorResult.ok) {
        diagnostics.push(
          attemptDiagnostic(attempt, locatorResult.code, locatorResult.message, artifact.id)
        )
        continue
      }
      const candidateKey = `${locatorResult.candidate.kind}\u0000${locatorResult.candidate.locator}`
      if (seenCandidates.has(candidateKey)) {
        diagnostics.push(
          attemptDiagnostic(
            attempt,
            'duplicate_candidate',
            'Duplicate Project reference candidate was omitted.',
            artifact.id
          )
        )
        continue
      }
      seenCandidates.add(candidateKey)
      intents.push({
        schemaVersion: 1,
        kind: 'project_reference_proposal',
        disposition: 'review_required',
        projectId: input.projectId.trim(),
        candidate: locatorResult.candidate,
        evidence: {
          executionId: input.executionId.trim(),
          outputStepId: input.outputStep.id,
          outputAttemptId: input.outputAttempt.id,
          sourceStepId: attempt.stepId,
          sourceAttemptId: attempt.id,
          artifactId: artifact.id,
          ...(artifact.digest ? { artifactDigest: artifact.digest } : {}),
          providerRunRef: result.providerRunRef,
          threadRef: result.threadRef,
          rootChatId: input.rootChatId.trim()
        }
      })
    }
  }
  return freezePlan(intents, diagnostics)
}
