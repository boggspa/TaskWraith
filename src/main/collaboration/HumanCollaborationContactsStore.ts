import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createHash } from 'crypto'
import type { UserBubbleColor } from '../store/types'

/**
 * A durable directory of people we have collaborated with, so re-inviting a
 * known collaborator is one click instead of a fresh out-of-band dance.
 *
 * WHY THIS IS A SEPARATE FILE FROM `HumanCollaborationIdentityStore`:
 * that store is a single-keypair vault (`{version:1, encryptedKey}` under
 * safeStorage) with no update API, and it deliberately HARD-THROWS rather than
 * regenerate a key it cannot parse, because collaborators pin that key —
 * silently replacing it would break reconnect for every existing share.
 * A contacts directory is the opposite kind of data: chatty, frequently
 * rewritten, and entirely reconstructible from the next handshake. Putting it
 * in the identity file would mean rewriting the pinned-key vault on every
 * encounter, i.e. giving a decorative cache the power to brick reconnect.
 * Hence a plain sibling JSON file, `<userData>/human-collaboration-contacts.json`,
 * following the `HumanCollaborationStore` persistence idiom (snapshot
 * interface + normalizeSnapshot + defensive parse + atomic tmp/rename write).
 */

/**
 * THE PUBLIC KEY IS THE IDENTITY. NOTHING ELSE ON THIS RECORD IS.
 *
 * `publicKeyId` is the only field a lookup may key on. `displayName` and
 * `colorIndex` are decoration hung off that key — collaborator-supplied,
 * mutable, and freely collidable.
 *
 * WHY it matters more here than in an ordinary address book: pinned-identity
 * re-admission lets a known contact rejoin with no invite token and no SAS
 * re-compare. If a contact could be resolved by display name, "re-invite Olly"
 * would become a no-SAS door for anyone who shows up calling themselves Olly.
 * Two different keys with the same name are two different people, always, and
 * neither one may ever be returned for a lookup of the other.
 */
export interface HumanCollaborationContact {
  /** Pinned Ed25519 public key id — the identity anchor, and the only lookup key. */
  publicKeyId: string
  /** Decoration. Sanitised on the way in; never used to match a record. */
  displayName: string
  /**
   * Index into `CONTACT_COLOR_PALETTE`. NOT a CSS string: this value crosses to
   * an untrusted client and lands in a CSS attribute selector, so a free-form
   * string would be an injection surface. An index can only ever resolve to one
   * of the fixed named hues.
   */
  colorIndex: number
  firstSeenAt: number
  lastSeenAt: number
  /** Chats this identity has actually participated in, most recent last. Bounded. */
  chatIds: string[]
  /** How many admissions we have recorded for this key. UI affordance only. */
  encounterCount: number
}

export interface HumanCollaborationContactsSnapshot {
  version: 1
  contacts: HumanCollaborationContact[]
}

export interface UpsertContactArgs {
  publicKeyId: string
  /** Collaborator-supplied and therefore untrusted; sanitised, never trusted as an id. */
  displayName?: string
  /** Records participation in this chat, if given. */
  chatId?: string
  /** Explicit palette index. Out-of-vocabulary values are rejected, not clamped. */
  colorIndex?: number
  now?: number
}

/**
 * The colour vocabulary is the existing `UserBubbleColor` hues (see
 * `src/main/store/types.ts`) minus `system`, which is "no tint" rather than a
 * hue and would make two contacts indistinguishable. Reusing that union rather
 * than inventing a palette means the renderer already has matching
 * `[data-user-bubble-color="X"]` rules, and the `UserBubbleColor` annotation
 * makes an invented hue a compile error rather than a dead CSS selector.
 */
export const CONTACT_COLOR_PALETTE: readonly UserBubbleColor[] = [
  'blue',
  'purple',
  'pink',
  'orange',
  'green',
  'red',
  'yellow',
  'graphite'
]

/**
 * Cap the directory. The whole file is rewritten on every persist, and an
 * unbounded JSON file rewritten synchronously on the main thread is a known
 * freeze class in this repo. 256 is far beyond any plausible human
 * collaborator roster while keeping the rewrite trivially cheap.
 *
 * EVICTION RULE: when the cap is exceeded, the contacts with the OLDEST
 * `lastSeenAt` are dropped first. An upsert always sets `lastSeenAt` to `now`,
 * so the contact you just touched is by construction never its own victim.
 */
export const MAX_CONTACTS = 256

/**
 * Per-contact chat history is also bounded — one long-running collaborator
 * across hundreds of chats is the same unbounded-rewrite problem in miniature.
 * Oldest chat ids fall off the front.
 */
export const MAX_CHAT_IDS_PER_CONTACT = 64

const MAX_DISPLAY_NAME_LENGTH = 80
const FALLBACK_DISPLAY_NAME = 'Collaborator'

export class HumanCollaborationContactsStore {
  private memory: HumanCollaborationContactsSnapshot = { version: 1, contacts: [] }

  constructor(
    private readonly storagePath?: string,
    private readonly log: (line: string) => void = () => {}
  ) {
    this.memory = this.load()
  }

  /** Most recently seen first — the order a "re-invite someone" picker wants. */
  listContacts(): HumanCollaborationContact[] {
    return cloneSnapshot(this.memory).contacts.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** Lookup is BY PUBLIC KEY ONLY. There is deliberately no lookup-by-name door. */
  getContact(publicKeyId: string): HumanCollaborationContact | null {
    const key = normalizePublicKeyId(publicKeyId)
    if (!key) return null
    const found = this.memory.contacts.find((contact) => contact.publicKeyId === key)
    return found ? cloneContact(found) : null
  }

  /**
   * The sole write door. Matches strictly on `publicKeyId`: a known key updates
   * in place (name/colour drift is expected and harmless), an unknown key
   * always creates a new record even if the display name is already taken.
   *
   * Returns `null` for an unusable key rather than throwing — see `persist`.
   */
  upsertContact(args: UpsertContactArgs): HumanCollaborationContact | null {
    const key = normalizePublicKeyId(args.publicKeyId)
    if (!key) return null
    const now = numberOrNow(args.now)

    const existing = this.memory.contacts.find((contact) => contact.publicKeyId === key)
    const colorIndex = resolveColorIndex(args.colorIndex, key, existing?.colorIndex)
    const chatIds = appendChatId(existing?.chatIds ?? [], args.chatId)

    const next: HumanCollaborationContact = {
      publicKeyId: key,
      // An omitted name keeps whatever we already had; it must never blank an
      // existing entry just because this particular frame carried no name.
      displayName: normalizeContactDisplayName(
        args.displayName ?? existing?.displayName ?? FALLBACK_DISPLAY_NAME
      ),
      colorIndex,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      chatIds,
      encounterCount: (existing?.encounterCount ?? 0) + 1
    }

    this.memory.contacts = existing
      ? this.memory.contacts.map((contact) => (contact.publicKeyId === key ? next : contact))
      : [...this.memory.contacts, next]
    this.memory.contacts = evictOldest(this.memory.contacts)
    this.persist()
    return cloneContact(next)
  }

  /** Returns whether anything was removed, so callers can skip a needless refresh. */
  forgetContact(publicKeyId: string): boolean {
    const key = normalizePublicKeyId(publicKeyId)
    if (!key) return false
    const before = this.memory.contacts.length
    this.memory.contacts = this.memory.contacts.filter((contact) => contact.publicKeyId !== key)
    if (this.memory.contacts.length === before) return false
    this.persist()
    return true
  }

  clear(): void {
    if (this.memory.contacts.length === 0) return
    this.memory.contacts = []
    this.persist()
  }

  /**
   * Degrades to an EMPTY directory on an absent, unreadable or corrupt file.
   *
   * This is the deliberate opposite of `HumanCollaborationIdentityStore`, which
   * throws on a file it cannot parse. The difference is what the data is worth:
   * the identity key is unrecoverable and pinned by remote peers, so quietly
   * replacing it destroys trust that cannot be rebuilt. A contacts book is a
   * convenience cache that the next handshake refills. Refusing to start
   * because the address book is damaged would let a decorative file block a
   * share — strictly worse than forgetting who we know.
   */
  private load(): HumanCollaborationContactsSnapshot {
    if (!this.storagePath || !existsSync(this.storagePath)) return { version: 1, contacts: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown
      return normalizeSnapshot(parsed)
    } catch (err) {
      this.log(`[human-collaboration] contacts unreadable, starting empty: ${describeError(err)}`)
      return { version: 1, contacts: [] }
    }
  }

  /**
   * Atomic tmp+rename so a crash mid-write cannot leave a half-written file,
   * and swallowing (only logging) failures for the same reason `load` does: a
   * read-only or full disk must degrade the address book, not fail the share
   * that is being set up around it.
   */
  private persist(): void {
    if (!this.storagePath) return
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      const tmp = `${this.storagePath}.tmp`
      writeFileSync(tmp, JSON.stringify(normalizeSnapshot(this.memory), null, 2), { mode: 0o600 })
      renameSync(tmp, this.storagePath)
    } catch (err) {
      this.log(`[human-collaboration] failed to persist contacts: ${describeError(err)}`)
    }
  }
}

/** Resolves a stored index to its hue. Anything out of range resolves to the first hue. */
export function contactColorName(colorIndex: number): UserBubbleColor {
  return isContactColorIndex(colorIndex)
    ? CONTACT_COLOR_PALETTE[colorIndex]
    : CONTACT_COLOR_PALETTE[0]
}

/** True only for an integer that indexes a real palette entry. */
export function isContactColorIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < CONTACT_COLOR_PALETTE.length
  )
}

/**
 * Deterministic per-identity default hue: the same key gets the same colour on
 * every machine with no stored agreement, so a contact stays visually stable
 * even before anyone picks a colour for them. Derived from the KEY, not the
 * name, so a rename cannot change someone's colour and two same-named people
 * still look different.
 */
export function derivedColorIndex(publicKeyId: string): number {
  const digest = createHash('sha256').update(publicKeyId, 'utf8').digest()
  return digest[0] % CONTACT_COLOR_PALETTE.length
}

/**
 * REJECT, don't clamp: a caller (or a hand-edited file) asking for hue 99 has a
 * bug or is probing, and clamping to 7 would hide it while still handing the
 * renderer a value it never asked for. Falling back to the derived hue keeps
 * the record inside the vocabulary by construction.
 */
function resolveColorIndex(
  requested: number | undefined,
  publicKeyId: string,
  existing: number | undefined
): number {
  if (isContactColorIndex(requested)) return requested
  if (isContactColorIndex(existing)) return existing
  return derivedColorIndex(publicKeyId)
}

/**
 * Display names arrive from the collaborator, so they are treated as hostile
 * text: control characters (which can forge line structure in logs and the
 * audit trail) and angle brackets (which reach markup-shaped surfaces) are
 * stripped rather than escaped, whitespace is collapsed, and the result is
 * length-capped so one contact cannot dominate a picker row.
 *
 * Impersonation-guarding ("Host", "Assistant", ...) deliberately lives in
 * `HumanCollaborationStore.normalizeDisplayName` and is NOT duplicated here:
 * that guard protects the transcript's speaker labels, and a second copy of
 * the reserved-name list would be a second source of truth that drifts.
 */
export function normalizeContactDisplayName(value: unknown): string {
  if (typeof value !== 'string') return FALLBACK_DISPLAY_NAME
  const stripped = Array.from(value)
    .map((char) => (isControlCharacter(char) ? ' ' : char))
    .join('')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return FALLBACK_DISPLAY_NAME
  return stripped.slice(0, MAX_DISPLAY_NAME_LENGTH).trim() || FALLBACK_DISPLAY_NAME
}

/**
 * C0 control characters plus DEL, matched by code point rather than by a regex
 * escape so no literal control byte ever has to live in this source file.
 */
function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 0x20 || code === 0x7f
}

function normalizePublicKeyId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function appendChatId(existing: string[], chatId: string | undefined): string[] {
  const trimmed = typeof chatId === 'string' ? chatId.trim() : ''
  if (!trimmed) return existing.slice(-MAX_CHAT_IDS_PER_CONTACT)
  // Re-participation moves the chat to the end (most recent last) instead of
  // duplicating it, so the bound counts distinct chats rather than visits.
  const without = existing.filter((entry) => entry !== trimmed)
  return [...without, trimmed].slice(-MAX_CHAT_IDS_PER_CONTACT)
}

/** Oldest `lastSeenAt` first — see MAX_CONTACTS for why the cap exists. */
function evictOldest(contacts: HumanCollaborationContact[]): HumanCollaborationContact[] {
  if (contacts.length <= MAX_CONTACTS) return contacts
  const survivors = [...contacts].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_CONTACTS)
  const keep = new Set(survivors.map((contact) => contact.publicKeyId))
  // Preserve insertion order for the survivors so persisted files stay stable
  // and diffable rather than being reshuffled by every eviction.
  return contacts.filter((contact) => keep.has(contact.publicKeyId))
}

/**
 * Every field is re-derived from the untrusted parse. Anything without a usable
 * `publicKeyId` is DROPPED rather than repaired: a record with no identity
 * anchor is not a contact, it is noise that a name-based lookup could later
 * mistake for someone.
 */
function normalizeSnapshot(value: unknown): HumanCollaborationContactsSnapshot {
  const raw = (value ?? {}) as Partial<HumanCollaborationContactsSnapshot>
  const seen = new Set<string>()
  const contacts: HumanCollaborationContact[] = []

  if (Array.isArray(raw.contacts)) {
    for (const entry of raw.contacts as Array<Partial<HumanCollaborationContact>>) {
      const publicKeyId = normalizePublicKeyId(entry?.publicKeyId)
      // A duplicated key in a hand-edited file collapses to its first record;
      // two live records for one identity would make lookups order-dependent.
      if (!publicKeyId || seen.has(publicKeyId)) continue
      seen.add(publicKeyId)
      const lastSeenAt = numberOrNow(entry.lastSeenAt)
      contacts.push({
        publicKeyId,
        displayName: normalizeContactDisplayName(entry.displayName),
        colorIndex: isContactColorIndex(entry.colorIndex)
          ? entry.colorIndex
          : derivedColorIndex(publicKeyId),
        firstSeenAt: typeof entry.firstSeenAt === 'number' ? entry.firstSeenAt : lastSeenAt,
        lastSeenAt,
        chatIds: Array.isArray(entry.chatIds)
          ? Array.from(
              new Set(
                entry.chatIds
                  .filter((chatId): chatId is string => typeof chatId === 'string')
                  .map((chatId) => chatId.trim())
                  .filter(Boolean)
              )
            ).slice(-MAX_CHAT_IDS_PER_CONTACT)
          : [],
        encounterCount:
          typeof entry.encounterCount === 'number' && entry.encounterCount > 0
            ? Math.floor(entry.encounterCount)
            : 1
      })
    }
  }

  return { version: 1, contacts: evictOldest(contacts) }
}

function numberOrNow(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function cloneSnapshot(
  snapshot: HumanCollaborationContactsSnapshot
): HumanCollaborationContactsSnapshot {
  return normalizeSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown)
}

function cloneContact(contact: HumanCollaborationContact): HumanCollaborationContact {
  return { ...contact, chatIds: [...contact.chatIds] }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
