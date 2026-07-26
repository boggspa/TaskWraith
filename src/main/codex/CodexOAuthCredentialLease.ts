import { homedir } from 'os'
import {
  CODEX_CREDENTIAL_LAYOUT,
  KimiOAuthCredentialAuthority,
  type KimiOAuthCredentialLeaseAcquireResult
} from '../kimi/KimiOAuthCredentialLease'
import { legacyCodexHomePath, taskWraithCodexHomePath } from './CodexHome'

/**
 * Borrow the user's REAL Codex credential instead of holding a second grant.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * TaskWraith runs Codex against its own private CODEX_HOME, which keeps its own
 * `auth.json`. That isolates state, but it also means TaskWraith holds a SECOND
 * ChatGPT grant for the same account — and on a plan that limits concurrent
 * Codex sessions the two revoke each other. The reported shape:
 *
 *   - signing in to TaskWraith logs the user out of the ChatGPT app
 *   - using the ChatGPT app leaves TaskWraith's token `token_revoked`
 *   - every individual sign-in "works", and none of them stick
 *
 * No amount of credential plumbing inside the private home fixes that, because
 * the second grant IS the problem.
 *
 * WHY A LEASE AND NOT A COPY
 * --------------------------
 * The obvious shortcut — copy `~/.codex/auth.json` into the private home — is
 * actively harmful. ChatGPT OAuth rotates its refresh token on use, so two
 * homes holding the same refresh token both try to rotate it and whichever
 * loses is revoked. That converts an occasional logout into a reliable one.
 *
 * So the credential is BORROWED under the same durable authority Kimi uses for
 * its single-use refresh token: claim → seed into the private home → provider
 * lifetime → atomically compare-and-swap any rotation back to `~/.codex` →
 * release. One grant, one rotation chain, and the user's own CLI and app stay
 * valid because rotations land back where they came from.
 *
 * KNOWN LIMIT. The lease serialises TaskWraith's OWN seats and guarantees
 * writeback; it cannot stop an external process (the ChatGPT desktop app)
 * rotating the same token while TaskWraith holds it. That is strictly better
 * than today — one grant instead of two — but it is not mutual exclusion with
 * software we do not control.
 *
 * OPT-IN. Reusing `~/.codex` trades containment for a working seat: TaskWraith
 * then reads and writes a credential file it otherwise never touches. Callers
 * must gate this on explicit user consent; the default stays the isolated home
 * with its own sign-in.
 */
export class CodexOAuthCredentialAuthority extends KimiOAuthCredentialAuthority {
  constructor(options: ConstructorParameters<typeof KimiOAuthCredentialAuthority>[0] = {}) {
    super({ ...options, credentialLayout: CODEX_CREDENTIAL_LAYOUT })
  }
}

const sharedCodexAuthority = new CodexOAuthCredentialAuthority()

export interface CodexOAuthCredentialLeaseInput {
  /** TaskWraith userData root; the private home is derived from it. */
  userDataPath: string
  /** Defaults to `~/.codex`. Injectable for tests. */
  sourceHome?: string
  /** Defaults to the shared process authority. Injectable for tests. */
  authority?: CodexOAuthCredentialAuthority
}

/**
 * Acquire a lease over the user's `~/.codex` credential, seeded into
 * TaskWraith's private Codex home.
 *
 * The private home is BOTH the isolated home and the boundary root: unlike
 * Kimi, which allocates a per-seat home beneath a shared boundary, Codex has a
 * single app-server home per TaskWraith session, so there is exactly one
 * borrower and no sibling seats to isolate from each other.
 */
export async function acquireCodexOAuthCredentialLease(
  input: CodexOAuthCredentialLeaseInput
): Promise<KimiOAuthCredentialLeaseAcquireResult> {
  const privateHome = taskWraithCodexHomePath(input.userDataPath)
  const authority = input.authority ?? sharedCodexAuthority
  return authority.acquire({
    sourceHome: input.sourceHome ?? legacyCodexHomePath(homedir()),
    isolatedHome: privateHome,
    boundaryRoot: privateHome
  })
}
