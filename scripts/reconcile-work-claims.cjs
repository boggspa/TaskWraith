#!/usr/bin/env node
'use strict'

// Report by default. Applying retires only expired contribution projections;
// journals, recovery refs, manual claims, runtime locks and source stay intact.
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { contributionExpiry, markerKind, markerMetadata } = require('./work-claim-policy.cjs')
const hash = (value) => createHash('sha256').update(value).digest('hex')

function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function regular(file, limit = 65536) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > limit || fs.lstatSync(file).isSymbolicLink())
      throw new Error('Not a bounded regular file')
    return fs.readFileSync(descriptor, 'utf8')
  } finally {
    fs.closeSync(descriptor)
  }
}

function evidence(root, journal, worktreeId, claim, refs) {
  const directory = path.join(journal, claim.id)
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
    throw new Error('Missing regular contribution journal')
  const names = fs
    .readdirSync(directory)
    .filter((name) => /^[a-f0-9-]{36}\.prepared\.json$/.test(name))
    .sort()
  if (!names.length || names.length > 2000)
    throw new Error('Missing or oversized contribution evidence')
  const records = names.map((name) => {
    const text = regular(path.join(directory, name))
    const record = JSON.parse(text)
    if (
      record.schemaVersion !== 1 ||
      record.contributionId !== claim.id ||
      `${record.id}.prepared.json` !== name ||
      record.actor?.lockOwnerId !== claim.owner ||
      hash(record.actor?.key || '') !== claim.id
    )
      throw new Error('Contribution identity does not match its journal')
    const ref = `refs/taskwraith/contributions/${worktreeId}/${record.id}`
    const settled = ['settled', 'aborted'].some((state) =>
      fs.existsSync(path.join(directory, `${record.id}.${state}.json`))
    )
    if (!settled && !refs.has(ref))
      throw new Error('Unsettled contribution is missing its recovery ref')
    return {
      id: record.id,
      sha256: hash(text),
      ref: refs.has(ref) ? ref : null,
      commit: refs.get(ref) || null
    }
  })
  return records
}

function reconcile(root, { apply = false, now = Date.now(), beforeRetire } = {}) {
  root = fs.realpathSync(root)
  if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root)
    throw new Error('Select a Git worktree root')
  const common = fs.realpathSync(
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )
  const worktreeId = hash(root)
  const journal = path.join(common, 'taskwraith', 'shared-workspace-v1', worktreeId)
  const refs = new Map(
    git(root, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      `refs/taskwraith/contributions/${worktreeId}/`
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
  )
  const results = []
  const names = fs
    .readdirSync(root)
    .filter((name) => /^(?:\.WORK-IN-PROGRESS-|SHIP-HOLD-|SESSION-IN-PROGRESS-).*\.md$/.test(name))
    .sort()
  if (names.length > 512) throw new Error('Too many markers; review manually')
  for (const file of names) {
    const result = { file, action: 'preserved', reason: '', records: 0 }
    results.push(result)
    try {
      const source = path.join(root, file)
      const text = regular(source)
      const metadata = markerMetadata(text)
      const kind = markerKind(file, metadata?.agent, metadata?.derived === 'true')
      if (kind !== 'contribution') {
        result.reason = `${kind} claim: owner review required`
        continue
      }
      const claim = contributionExpiry(file, text)
      if (!claim) {
        result.reason = 'unrecognised contribution format'
        continue
      }
      if (now <= claim.expires) {
        result.reason = 'lease is still current'
        continue
      }
      const records = evidence(root, journal, worktreeId, claim, refs)
      result.records = records.length
      result.action = 'eligible'
      result.reason = 'expired intent; recovery evidence verified'
      if (!apply) continue
      const directory = path.join(
        common,
        'taskwraith',
        'retired-intent-claims',
        worktreeId,
        claim.id
      )
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const archive = path.join(directory, `${hash(text)}.md`)
      if (fs.existsSync(archive)) {
        if (regular(archive) !== text) throw new Error('Archive content mismatch')
      } else {
        const fd = fs.openSync(archive, 'wx', 0o600)
        try {
          fs.writeFileSync(fd, text)
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      }
      const receipt = path.join(directory, `${hash(text)}.${randomUUID()}.json`)
      fs.writeFileSync(
        receipt,
        JSON.stringify(
          { schemaVersion: 1, root, file, archive, at: new Date(now).toISOString(), records },
          null,
          2
        ) + '\n',
        { flag: 'wx', mode: 0o600 }
      )
      beforeRetire?.(source)
      if (regular(source) !== text) {
        result.action = 'preserved'
        result.reason = 'marker changed during reconciliation'
        continue
      }
      // Rename captures the actual inode. A renewal racing this operation is
      // restored without overwriting any still newer replacement.
      const captured = path.join(directory, `captured-${randomUUID()}.md`)
      fs.renameSync(source, captured)
      if (regular(captured) !== text) {
        try {
          fs.linkSync(captured, source)
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
        result.action = 'preserved'
        result.reason = `concurrent renewal retained at ${captured}`
        continue
      }
      fs.unlinkSync(captured)
      result.action = 'archived'
      result.archive = archive
      result.receipt = receipt
    } catch (error) {
      result.action = 'preserved'
      result.reason = error.message
    }
  }
  return { schemaVersion: 1, root, apply, markers: results }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg.startsWith('--') && !['--apply', '--json'].includes(arg)))
    throw new Error('Usage: reconcile-work-claims.cjs [worktree] [--apply] [--json]')
  const result = reconcile(args.find((arg) => !arg.startsWith('--')) || process.cwd(), {
    apply: args.includes('--apply')
  })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
module.exports = { reconcile }
