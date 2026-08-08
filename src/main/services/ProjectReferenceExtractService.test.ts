import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectReference } from '../../shared/projects'
import {
  PROJECT_REFERENCE_EXTRACTS_DIR_NAME,
  ProjectReferenceExtractStore
} from './ProjectReferenceExtractStore'
import {
  PROJECT_REFERENCE_EXTRACT_FETCH_MAX_BYTES,
  PROJECT_REFERENCE_EXTRACT_KEEP_CHARS,
  ProjectReferenceExtractService
} from './ProjectReferenceExtractService'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tw-extract-svc-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

const consent = {
  at: 1_700_000_000_000,
  actor: 'user' as const,
  scope: 'this-reference' as const,
  chatId: 'chat-a'
}

function ref(
  partial: Partial<ProjectReference> & Pick<ProjectReference, 'id' | 'kind' | 'locator'>
): ProjectReference {
  return {
    projectId: 'project-a',
    title: partial.title ?? 'Reference',
    provenance: { addedBy: 'user', addedAt: 1 },
    contextPolicy: 'available',
    updatedAt: 1,
    ...partial
  }
}

function makeService(options: {
  references: ProjectReference[]
  fetchImpl?: typeof fetch
  resolveHost?: (host: string) => Promise<string[]>
  extractPdfText?: ConstructorParameters<typeof ProjectReferenceExtractService>[0]['extractPdfText']
}): { service: ProjectReferenceExtractService; store: ProjectReferenceExtractStore } {
  const root = makeRoot()
  const store = new ProjectReferenceExtractStore(
    path.join(root, PROJECT_REFERENCE_EXTRACTS_DIR_NAME)
  )
  const service = new ProjectReferenceExtractService({
    store,
    getReferences: () => options.references,
    fetchImpl: options.fetchImpl,
    resolveHost: options.resolveHost ?? (async () => ['93.184.216.34']),
    extractPdfText: options.extractPdfText,
    now: () => 1_700_000_000_100
  })
  return { service, store }
}

describe('ProjectReferenceExtractService', () => {
  it('fails closed without an explicit consent object', async () => {
    const { service, store } = makeService({
      references: [ref({ id: 'ref-url', kind: 'url', locator: 'https://example.com/a' })]
    })
    const result = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-url',
      consent: null as never
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('consent_required')
    expect(store.getActive('project-a', 'ref-url')).toBeNull()
  })

  it('fails when the reference is missing or belongs to another project', async () => {
    const { service } = makeService({
      references: [
        ref({
          id: 'ref-url',
          kind: 'url',
          locator: 'https://example.com/a',
          projectId: 'project-b'
        })
      ]
    })
    const missing = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'nope',
      consent
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('reference_not_found')

    const wrongProject = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-url',
      consent
    })
    expect(wrongProject.ok).toBe(false)
    if (!wrongProject.ok) expect(wrongProject.code).toBe('reference_not_found')
  })

  it('rejects folder and connector references in P1', async () => {
    const { service, store } = makeService({
      references: [
        ref({ id: 'ref-folder', kind: 'folder', locator: '/tmp/docs' }),
        ref({ id: 'ref-conn', kind: 'connector', locator: 'github:org/repo' })
      ]
    })
    const folder = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-folder',
      consent
    })
    expect(folder.ok).toBe(false)
    if (!folder.ok) expect(folder.code).toBe('unsupported_kind')
    expect(store.getActive('project-a', 'ref-folder')).toBeNull()

    const connector = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-conn',
      consent
    })
    expect(connector.ok).toBe(false)
    if (!connector.ok) expect(connector.code).toBe('unsupported_kind')
  })

  it('fetches a URL once through SSRF, stores url-html, and caps kept text', async () => {
    const huge = `Hello extract ${'x'.repeat(PROJECT_REFERENCE_EXTRACT_KEEP_CHARS)}`
    const html = `<html><head><title>T</title></head><body><p>${huge}</p></body></html>`
    const fetchImpl = vi.fn(
      async () =>
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
    ) as unknown as typeof fetch

    const { service, store } = makeService({
      references: [ref({ id: 'ref-url', kind: 'url', locator: 'https://example.com/doc' })],
      fetchImpl
    })

    const result = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-url',
      consent
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.extract.kind).toBe('url-html')
    expect(result.extract.status).toBe('ready')
    expect(result.extract.source.http?.status).toBe(200)
    expect(result.extract.text?.truncated).toBe(true)
    expect(result.extract.text?.charCount).toBeLessThanOrEqual(PROJECT_REFERENCE_EXTRACT_KEEP_CHARS)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const text = store.readText(result.extract.id)
    expect(text?.startsWith('Hello extract')).toBe(true)
    expect(text?.length).toBeLessThanOrEqual(PROJECT_REFERENCE_EXTRACT_KEEP_CHARS)
  })

  it('marks failed when the URL fetch exceeds the byte cap', async () => {
    const body = 'y'.repeat(PROJECT_REFERENCE_EXTRACT_FETCH_MAX_BYTES + 1)
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(body.length)
          }
        })
    ) as unknown as typeof fetch

    const { service, store } = makeService({
      references: [ref({ id: 'ref-url', kind: 'url', locator: 'https://example.com/big' })],
      fetchImpl
    })

    const result = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-url',
      consent
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('fetch_too_large')
    const active = store.getActive('project-a', 'ref-url')
    expect(active?.status).toBe('failed')
    expect(active?.error?.code).toBe('fetch_too_large')
  })

  it('extracts PDF text via PdfTextExtractor and stores pdf-text pages', async () => {
    const root = makeRoot()
    const pdfPath = path.join(root, 'spec.pdf')
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4 mock'))

    const extractPdfText = vi.fn(async () => ({
      pageCount: 2,
      pagesRead: 2,
      pages: [
        { pageNumber: 1, text: 'Page one' },
        { pageNumber: 2, text: 'Page two' }
      ],
      text: 'Page one\n\nPage two',
      needsOcr: false,
      truncated: false
    }))

    const { service } = makeService({
      references: [ref({ id: 'ref-pdf', kind: 'file', locator: pdfPath, title: 'spec.pdf' })],
      extractPdfText
    })

    const result = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-pdf',
      consent
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.extract.kind).toBe('pdf-text')
    expect(result.extract.status).toBe('ready')
    expect(result.extract.text?.pages?.length).toBe(2)
    expect(extractPdfText).toHaveBeenCalledTimes(1)
    expect(result.extract.source.contentSha256).toBe(
      createHash('sha256').update(Buffer.from('%PDF-1.4 mock')).digest('hex')
    )
  })

  it('extracts office documents to markdown/csv as office-text', async () => {
    const { buildDocx } = await import('../office/DocxCodec')
    const root = makeRoot()
    const docxPath = path.join(root, 'brief.docx')
    const archive = buildDocx({
      kind: 'word',
      blocks: [{ type: 'paragraph', runs: [{ text: 'Office extract body' }] }]
    })
    fs.writeFileSync(docxPath, archive)

    const { service, store } = makeService({
      references: [ref({ id: 'ref-docx', kind: 'file', locator: docxPath, title: 'brief.docx' })]
    })

    const result = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-docx',
      consent
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.extract.kind).toBe('office-text')
    expect(result.extract.source.officeFormat).toBe('docx')
    expect(store.readText(result.extract.id)).toContain('Office extract body')
  })

  it('does not mutate ProjectReference catalogue semantics', async () => {
    const references = [ref({ id: 'ref-url', kind: 'url', locator: 'https://example.com/a' })]
    const before = structuredClone(references[0])
    const fetchImpl = vi.fn(
      async () => new Response('ok', { status: 200 })
    ) as unknown as typeof fetch
    const { service } = makeService({ references, fetchImpl })
    await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-url',
      consent
    })
    expect(references[0]).toEqual(before)
  })

  it('fails closed with locator_changed when the URL locator changes after consent pin', async () => {
    const root = makeRoot()
    const store = new ProjectReferenceExtractStore(
      path.join(root, PROJECT_REFERENCE_EXTRACTS_DIR_NAME)
    )
    let loads = 0
    const fetchImpl = vi.fn(
      async () => new Response('should-not-fetch', { status: 200 })
    ) as unknown as typeof fetch
    const service = new ProjectReferenceExtractService({
      store,
      getReferences: () => {
        loads += 1
        const locator =
          loads === 1 ? 'https://example.com/consented' : 'https://example.com/mutated'
        return [ref({ id: 'ref-url', kind: 'url', locator })]
      },
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      now: () => 1_700_000_000_100
    })

    const result = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-url',
      consent
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('locator_changed')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.getActive('project-a', 'ref-url')).toBeNull()
  })

  it('fails closed with locator_changed when the file locator changes after consent pin', async () => {
    const root = makeRoot()
    const consentedPath = path.join(root, 'consented.pdf')
    const mutatedPath = path.join(root, 'mutated.pdf')
    fs.writeFileSync(consentedPath, Buffer.from('%PDF-1.4 consented'))
    fs.writeFileSync(mutatedPath, Buffer.from('%PDF-1.4 mutated'))
    const store = new ProjectReferenceExtractStore(
      path.join(root, PROJECT_REFERENCE_EXTRACTS_DIR_NAME)
    )
    let loads = 0
    const extractPdfText = vi.fn(async () => {
      throw new Error('must not parse after locator change')
    })
    const service = new ProjectReferenceExtractService({
      store,
      getReferences: () => {
        loads += 1
        const locator = loads === 1 ? consentedPath : mutatedPath
        return [ref({ id: 'ref-pdf', kind: 'file', locator, title: 'spec.pdf' })]
      },
      extractPdfText,
      now: () => 1_700_000_000_100
    })

    const result = await service.requestExtract({
      projectId: 'project-a',
      referenceId: 'ref-pdf',
      consent
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('locator_changed')
    expect(extractPdfText).not.toHaveBeenCalled()
    expect(store.getActive('project-a', 'ref-pdf')).toBeNull()
  })
})
