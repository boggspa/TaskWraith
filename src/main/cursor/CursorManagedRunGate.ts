import { cursorRuntimeQualificationsPresent } from './CursorRuntimeAdmission'

export interface CursorManagedRunAdmission {
  /** Always false at this coarse synchronous gate. It never authorizes a spawn
   * on its own: the exact binary is only verified by the async
   * `admitCursorRuntime` probe/recheck at the (future) launch path. `allowed`
   * exists so callers can branch without depending on the message text. */
  allowed: boolean
  /** True while no exact-build Cursor tuple is embedded — the shipped state.
   * Drives the "Managed runs unavailable" surfaces. Flips to false only once a
   * reviewed fingerprint is admitted into the embedded roster. */
  securityUnavailable: boolean
  message: string
}

const CURSOR_NO_QUALIFIED_BUILD_MESSAGE =
  'Cursor managed runs are temporarily disabled: the current Cursor CLI initializes provider-managed account/team hooks, skills, plugins, and MCP sources before a turn, and no reviewed exact-build containment fingerprint has been admitted into the embedded roster. No Cursor process was started. Use another provider while the exact-build containment canary is pending.'

const CURSOR_EXACT_BUILD_ADMISSION_REQUIRED_MESSAGE =
  'Cursor managed runs require exact-build runtime admission: TaskWraith admits only a reviewed cursor-agent build via CursorRuntimeAdmission before any process is started. No Cursor process was started by this gate.'

/**
 * Qualification-driven release gate for Cursor. It consults CursorRuntimeAdmission
 * (deny-unless-qualified): while the embedded runtime roster is EMPTY — the
 * shipped, fail-closed state — it returns securityUnavailable:true and callers
 * keep showing "Managed runs unavailable". Authentication and a private
 * filesystem profile do not contain Cursor's provider-managed startup hooks,
 * skills, plugins, MCP sources, or retained approvals, so admission is never a
 * function of credentials — only of the reviewed exact-build roster.
 *
 * `allowed` is intentionally always false here: this coarse synchronous gate
 * cannot verify the exact binary. The per-build authorization is the async
 * `admitCursorRuntime` probe at the launch path (not wired for production while
 * the roster is empty), so this gate can never fail open.
 */
export function resolveCursorManagedRunAdmission(
  qualificationsPresent: boolean
): CursorManagedRunAdmission {
  if (!qualificationsPresent) {
    return {
      allowed: false,
      securityUnavailable: true,
      message: CURSOR_NO_QUALIFIED_BUILD_MESSAGE
    }
  }
  return {
    allowed: false,
    securityUnavailable: false,
    message: CURSOR_EXACT_BUILD_ADMISSION_REQUIRED_MESSAGE
  }
}

export function cursorManagedRunAdmission(): CursorManagedRunAdmission {
  return resolveCursorManagedRunAdmission(cursorRuntimeQualificationsPresent())
}
