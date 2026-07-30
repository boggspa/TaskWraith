import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTACT_COLOR_PALETTE,
  HumanCollaborationContactsStore,
  MAX_CHAT_IDS_PER_CONTACT,
  MAX_CONTACTS,
  contactColorName,
  derivedColorIndex,
  isContactColorIndex,
  normalizeContactDisplayName
} from './HumanCollaborationContactsStore'

const tempDirs: string[] = []

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-contacts-'))
  tempDirs.push(dir)
  return join(dir, 'human-collaboration-contacts.json')
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('HumanCollaborationContactsStore', () => {
  it('keys contacts on the public key: the same key with a new name updates in place', () => {
    const store = new HumanCollaborationContactsStore()
    store.upsertContact({
      publicKeyId: 'ed25519:olly',
      displayName: 'Olly',
      chatId: 'chat-1',
      now: 1000
    })
    const renamed = store.upsertContact({
      publicKeyId: 'ed25519:olly',
      displayName: 'Oliver Q',
      chatId: 'chat-2',
      now: 2000
    })

    expect(store.listContacts()).toHaveLength(1)
    expect(renamed).toMatchObject({
      publicKeyId: 'ed25519:olly',
      displayName: 'Oliver Q',
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      encounterCount: 2
    })
    expect(renamed?.chatIds).toEqual(['chat-1', 'chat-2'])
  })

  // LOAD-BEARING SECURITY TEST — do not relax.
  // Pinned-identity re-admission skips the invite token and the SAS compare, so
  // if a contact could ever be resolved by display name, "re-invite Olly" would
  // become a no-SAS door for anyone who turns up calling themselves Olly.
  it('SECURITY: a different public key with the SAME display name is a separate contact and never matches the first', () => {
    const store = new HumanCollaborationContactsStore()
    const real = store.upsertContact({
      publicKeyId: 'ed25519:real-olly',
      displayName: 'Olly',
      chatId: 'chat-1',
      now: 1000
    })
    const impostor = store.upsertContact({
      publicKeyId: 'ed25519:impostor',
      displayName: 'Olly',
      chatId: 'chat-9',
      now: 2000
    })

    expect(store.listContacts()).toHaveLength(2)
    expect(real?.publicKeyId).not.toBe(impostor?.publicKeyId)

    // Lookup is by key only, and each key resolves to its own record.
    expect(store.getContact('ed25519:real-olly')?.chatIds).toEqual(['chat-1'])
    expect(store.getContact('ed25519:impostor')?.chatIds).toEqual(['chat-9'])

    // There is deliberately no name-shaped lookup door: passing the display
    // name where a key is expected must resolve to nobody.
    expect(store.getContact('Olly')).toBeNull()

    // Forgetting the impostor must not touch the real contact.
    expect(store.forgetContact('ed25519:impostor')).toBe(true)
    expect(store.getContact('ed25519:real-olly')).not.toBeNull()
    expect(store.getContact('ed25519:impostor')).toBeNull()
  })

  it('SECURITY: a persisted record whose key differs only by trailing whitespace stays one identity, not two', () => {
    const path = tempStorePath()
    const store = new HumanCollaborationContactsStore(path)
    store.upsertContact({ publicKeyId: 'ed25519:olly', displayName: 'Olly', now: 1000 })
    store.upsertContact({ publicKeyId: '  ed25519:olly  ', displayName: 'Olly', now: 2000 })
    expect(store.listContacts()).toHaveLength(1)
    // A blank key is not an identity at all and must never create a record.
    expect(store.upsertContact({ publicKeyId: '   ', displayName: 'Ghost' })).toBeNull()
    expect(store.listContacts()).toHaveLength(1)
  })

  it('persists across instances and round-trips through the sibling JSON file', () => {
    const path = tempStorePath()
    const first = new HumanCollaborationContactsStore(path)
    first.upsertContact({
      publicKeyId: 'ed25519:olly',
      displayName: 'Olly',
      chatId: 'chat-1',
      colorIndex: 3,
      now: 1000
    })

    const reloaded = new HumanCollaborationContactsStore(path)
    expect(reloaded.getContact('ed25519:olly')).toMatchObject({
      displayName: 'Olly',
      colorIndex: 3,
      chatIds: ['chat-1']
    })
    // Never written into the identity vault; this is its own file.
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('degrades to an empty directory when the file is corrupt, and keeps accepting writes', () => {
    const path = tempStorePath()
    writeFileSync(path, '{ this is not json at all')

    const lines: string[] = []
    const open = (): HumanCollaborationContactsStore =>
      new HumanCollaborationContactsStore(path, (line) => lines.push(line))
    expect(open).not.toThrow()

    const store = open()
    expect(store.listContacts()).toEqual([])
    expect(lines.join('\n')).toContain('contacts unreadable')

    // Losing the address book must never block the share that follows it.
    expect(store.upsertContact({ publicKeyId: 'ed25519:olly', displayName: 'Olly' })).not.toBeNull()
    expect(new HumanCollaborationContactsStore(path).listContacts()).toHaveLength(1)
  })

  it('degrades to an empty directory for structurally wrong or anchor-less records', () => {
    const path = tempStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        contacts: [
          { displayName: 'No key here', colorIndex: 1 },
          { publicKeyId: '', displayName: 'Blank key' },
          'not-an-object',
          null
        ]
      })
    )
    expect(new HumanCollaborationContactsStore(path).listContacts()).toEqual([])

    const notAnObject = tempStorePath()
    writeFileSync(notAnObject, '["shares", 12]')
    expect(new HumanCollaborationContactsStore(notAnObject).listContacts()).toEqual([])
  })

  it('evicts the oldest lastSeenAt first once the cap is reached', () => {
    const store = new HumanCollaborationContactsStore()
    for (let i = 0; i < MAX_CONTACTS; i += 1) {
      store.upsertContact({ publicKeyId: `key-${i}`, displayName: `Person ${i}`, now: 1000 + i })
    }
    expect(store.listContacts()).toHaveLength(MAX_CONTACTS)

    // key-0 is the oldest lastSeenAt, so it is the one that goes.
    store.upsertContact({ publicKeyId: 'key-new', displayName: 'Newcomer', now: 9_000_000 })
    expect(store.listContacts()).toHaveLength(MAX_CONTACTS)
    expect(store.getContact('key-0')).toBeNull()
    expect(store.getContact('key-1')).not.toBeNull()
    expect(store.getContact('key-new')).not.toBeNull()

    // Touching the oldest survivor makes it the newest, so the NEXT eviction
    // takes key-2 instead. An upsert can never evict the contact it just wrote.
    store.upsertContact({ publicKeyId: 'key-1', displayName: 'Person 1', now: 9_000_001 })
    store.upsertContact({ publicKeyId: 'key-newer', displayName: 'Newer', now: 9_000_002 })
    expect(store.getContact('key-2')).toBeNull()
    expect(store.getContact('key-1')).not.toBeNull()
    expect(store.getContact('key-newer')).not.toBeNull()
  })

  it('bounds the per-contact chat list and dedupes re-participation', () => {
    const store = new HumanCollaborationContactsStore()
    for (let i = 0; i < MAX_CHAT_IDS_PER_CONTACT + 5; i += 1) {
      store.upsertContact({ publicKeyId: 'ed25519:olly', chatId: `chat-${i}`, now: 1000 + i })
    }
    const contact = store.getContact('ed25519:olly')
    expect(contact?.chatIds).toHaveLength(MAX_CHAT_IDS_PER_CONTACT)
    expect(contact?.chatIds[0]).toBe('chat-5')

    store.upsertContact({ publicKeyId: 'ed25519:olly', chatId: 'chat-5', now: 99_999 })
    const after = store.getContact('ed25519:olly')
    expect(after?.chatIds).toHaveLength(MAX_CHAT_IDS_PER_CONTACT)
    expect(after?.chatIds.filter((id) => id === 'chat-5')).toHaveLength(1)
    expect(after?.chatIds[after.chatIds.length - 1]).toBe('chat-5')
  })

  it('sanitises collaborator-supplied display names on the way in', () => {
    expect(normalizeContactDisplayName('  Olly   Q  ')).toBe('Olly Q')
    expect(normalizeContactDisplayName('<script>alert(1)</script>')).toBe('scriptalert(1)/script')
    expect(normalizeContactDisplayName(`Olly${String.fromCharCode(0)}Root`)).toBe('Olly Root')
    expect(normalizeContactDisplayName('Line\r\nTwo\tThree')).toBe('Line Two Three')
    expect(normalizeContactDisplayName('x'.repeat(500))).toHaveLength(80)
    expect(normalizeContactDisplayName('')).toBe('Collaborator')
    expect(normalizeContactDisplayName(undefined)).toBe('Collaborator')
    expect(normalizeContactDisplayName({ toString: () => 'Olly' })).toBe('Collaborator')

    const store = new HumanCollaborationContactsStore()
    const contact = store.upsertContact({
      publicKeyId: 'ed25519:olly',
      displayName: `<b>Ol${String.fromCharCode(27)}ly</b>`
    })
    expect(contact?.displayName).toBe('bOl ly/b')
  })

  it('keeps an existing name when an encounter carries no name at all', () => {
    const store = new HumanCollaborationContactsStore()
    store.upsertContact({ publicKeyId: 'ed25519:olly', displayName: 'Olly', now: 1000 })
    store.upsertContact({ publicKeyId: 'ed25519:olly', chatId: 'chat-2', now: 2000 })
    expect(store.getContact('ed25519:olly')?.displayName).toBe('Olly')
  })

  it('rejects an out-of-vocabulary colour rather than clamping or storing it', () => {
    expect(isContactColorIndex(0)).toBe(true)
    expect(isContactColorIndex(CONTACT_COLOR_PALETTE.length - 1)).toBe(true)
    expect(isContactColorIndex(CONTACT_COLOR_PALETTE.length)).toBe(false)
    expect(isContactColorIndex(-1)).toBe(false)
    expect(isContactColorIndex(1.5)).toBe(false)
    expect(isContactColorIndex(Number.NaN)).toBe(false)
    expect(isContactColorIndex('red')).toBe(false)

    const store = new HumanCollaborationContactsStore()
    const overflow = store.upsertContact({
      publicKeyId: 'ed25519:olly',
      displayName: 'Olly',
      colorIndex: 99
    })
    // Rejected: falls back to the key-derived hue, never 99 and never clamped to 7.
    expect(overflow?.colorIndex).toBe(derivedColorIndex('ed25519:olly'))
    expect(CONTACT_COLOR_PALETTE).toContain(contactColorName(overflow?.colorIndex ?? -1))
  })

  it('rejects a CSS-shaped colour smuggled in through the persisted file', () => {
    const path = tempStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        contacts: [
          {
            publicKeyId: 'ed25519:olly',
            displayName: 'Olly',
            // A free-form string here would land in a CSS attribute selector.
            colorIndex: 'red; background: url(https://evil.example/x)',
            lastSeenAt: 1000,
            chatIds: ['chat-1'],
            encounterCount: 1
          }
        ]
      })
    )

    const loaded = new HumanCollaborationContactsStore(path).getContact('ed25519:olly')
    expect(typeof loaded?.colorIndex).toBe('number')
    expect(isContactColorIndex(loaded?.colorIndex)).toBe(true)
    expect(CONTACT_COLOR_PALETTE).toContain(contactColorName(loaded?.colorIndex ?? -1))
  })

  it('gives every palette index a named hue and every key a stable derived hue', () => {
    expect(CONTACT_COLOR_PALETTE).toHaveLength(8)
    // `system` is "no tint", not a hue — two contacts on it would be indistinguishable.
    expect(CONTACT_COLOR_PALETTE).not.toContain('system')
    for (let i = 0; i < CONTACT_COLOR_PALETTE.length; i += 1) {
      expect(contactColorName(i)).toBe(CONTACT_COLOR_PALETTE[i])
    }
    expect(derivedColorIndex('ed25519:olly')).toBe(derivedColorIndex('ed25519:olly'))
    expect(isContactColorIndex(derivedColorIndex('anything-at-all'))).toBe(true)
  })

  it('collapses duplicate keys in a hand-edited file to a single record', () => {
    const path = tempStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        contacts: [
          { publicKeyId: 'ed25519:olly', displayName: 'First', lastSeenAt: 1000 },
          { publicKeyId: 'ed25519:olly', displayName: 'Shadow', lastSeenAt: 2000 }
        ]
      })
    )
    const contacts = new HumanCollaborationContactsStore(path).listContacts()
    expect(contacts).toHaveLength(1)
    expect(contacts[0].displayName).toBe('First')
  })

  it('lists most recently seen first and hands back defensive copies', () => {
    const store = new HumanCollaborationContactsStore()
    store.upsertContact({ publicKeyId: 'a', displayName: 'A', chatId: 'chat-a', now: 1000 })
    store.upsertContact({ publicKeyId: 'b', displayName: 'B', now: 3000 })
    store.upsertContact({ publicKeyId: 'c', displayName: 'C', now: 2000 })
    expect(store.listContacts().map((contact) => contact.publicKeyId)).toEqual(['b', 'c', 'a'])

    const snapshot = store.listContacts()
    snapshot[0].displayName = 'MUTATED'
    snapshot[0].chatIds.push('chat-injected')
    expect(store.getContact('b')?.displayName).toBe('B')
    expect(store.getContact('a')?.chatIds).toEqual(['chat-a'])
  })

  it('clears the directory and reports whether a forget actually removed anything', () => {
    const path = tempStorePath()
    const store = new HumanCollaborationContactsStore(path)
    store.upsertContact({ publicKeyId: 'a', displayName: 'A' })
    expect(store.forgetContact('nobody')).toBe(false)
    expect(store.forgetContact('')).toBe(false)
    store.clear()
    expect(store.listContacts()).toEqual([])
    expect(new HumanCollaborationContactsStore(path).listContacts()).toEqual([])
  })

  it('never throws when the storage path cannot be written', () => {
    // A path whose parent is a FILE cannot be mkdir'd — the persist must be
    // logged and swallowed so a broken disk cannot fail the share around it.
    const path = tempStorePath()
    writeFileSync(path, '{"version":1,"contacts":[]}')
    const unwritable = join(path, 'nested', 'contacts.json')

    const lines: string[] = []
    const store = new HumanCollaborationContactsStore(unwritable, (line) => lines.push(line))
    expect(() => store.upsertContact({ publicKeyId: 'a', displayName: 'A' })).not.toThrow()
    expect(store.getContact('a')).not.toBeNull()
    expect(lines.join('\n')).toContain('failed to persist contacts')
  })
})
