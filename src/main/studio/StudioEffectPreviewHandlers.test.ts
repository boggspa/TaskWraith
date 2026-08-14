import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STUDIO_EFFECT_PREVIEW_CLEAR_CHANNEL,
  STUDIO_EFFECT_PREVIEW_LOAD_CHANNEL,
  STUDIO_EFFECT_PREVIEW_STATE_CHANNEL,
  createStudioEffectPreviewHandlers,
  registerStudioEffectPreviewHandlers,
  type StudioEffectPreviewLifecycleLike
} from './StudioEffectPreviewHandlers'
import { loadStudioEffectPreview } from './StudioEffectPreviewSource'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true }))
  )
})

function temporaryRoot(label: string): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), label)))
  roots.push(root)
  return root
}

/** A minimal but structurally valid 2x2x2 cube. */
function identityCube(title = 'identity'): string {
  const lines = [`TITLE "${title}"`, 'LUT_3D_SIZE 2']
  for (let index = 0; index < 8; index += 1) {
    const r = index & 1 ? '1.0' : '0.0'
    const g = index & 2 ? '1.0' : '0.0'
    const b = index & 4 ? '1.0' : '0.0'
    lines.push(`${r} ${g} ${b}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * A real lifecycle stand-in: it keeps a genuine document and records every
 * path handed to setEffectPreview, so tests assert on what production would
 * actually deliver rather than on a returned shape.
 */
function fakeLifecycle(effectPreviewRoot: string): {
  lifecycle: StudioEffectPreviewLifecycleLike
  applied: (string | null)[]
  failNext: (code: string) => void
} {
  const applied: (string | null)[] = []
  let document: { effectPreview: { effectId: string } | null } = { effectPreview: null }
  let pendingFailure: string | null = null

  return {
    applied,
    failNext: (code: string) => {
      pendingFailure = code
    },
    lifecycle: {
      paths: { effectPreviewRoot },
      store: { getDocument: () => document },
      async setEffectPreview(cubePath: string | null) {
        if (pendingFailure) {
          const code = pendingFailure
          pendingFailure = null
          return { ok: false, code, message: 'refused' }
        }
        applied.push(cubePath)
        if (cubePath === null) {
          document = { effectPreview: null }
          return { ok: true }
        }
        // Re-validate exactly the way production does, through the real jailed
        // loader. If the handler ever hands over a path outside the owned root
        // this throws, which is the point.
        const preview = loadStudioEffectPreview({
          path: cubePath,
          allowedMediaRoots: [effectPreviewRoot]
        })
        document = { effectPreview: { effectId: preview.effectId } }
        return { ok: true }
      }
    }
  }
}

describe('StudioEffectPreviewHandlers', () => {
  it('loads an operator-chosen cube and applies it through the jailed loader', async () => {
    const root = temporaryRoot('studio-effect-root-')
    const outside = temporaryRoot('studio-operator-files-')
    const chosen = nodePath.join(outside, 'Filmic Warm.cube')
    fs.writeFileSync(chosen, identityCube('warm'), 'utf8')

    const { lifecycle, applied } = fakeLifecycle(root)
    const handlers = createStudioEffectPreviewHandlers({
      getLifecycle: () => lifecycle,
      showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] })
    })

    const result = await handlers.load()

    expect(result.ok).toBe(true)
    expect(result.state.active).toBe(true)
    expect(result.state.displayName).toBe('Filmic Warm.cube')
    // The applied path must be INSIDE the owned root, never the operator's path.
    expect(applied).toHaveLength(1)
    const [appliedPath] = applied
    expect(appliedPath).not.toBeNull()
    expect(appliedPath).not.toBe(chosen)
    expect(nodePath.dirname(appliedPath as string)).toBe(root)
  })

  /**
   * The regression control for the defect this slice exists to repair: while
   * `setEffectPreview` was jailed to the transcript-media CAS, the intersection
   * of "*.cube" and "inside that root" was EMPTY, so every operator file was
   * refused. Pointing the lifecycle at that root must still refuse, proving the
   * jail is real and that the fix is the ROOT, not a loosened check.
   */
  it('would still be refused if the jail pointed at a root the import never writes to', async () => {
    const importRoot = temporaryRoot('studio-effect-root-')
    const foreignRoot = temporaryRoot('studio-transcript-media-')
    const outside = temporaryRoot('studio-operator-files-')
    const chosen = nodePath.join(outside, 'look.cube')
    fs.writeFileSync(chosen, identityCube(), 'utf8')

    const { lifecycle } = fakeLifecycle(importRoot)
    // Import into the Studio root, but validate against the foreign one.
    const misjailed: StudioEffectPreviewLifecycleLike = {
      ...lifecycle,
      async setEffectPreview(cubePath: string | null) {
        if (cubePath === null) return { ok: true }
        try {
          loadStudioEffectPreview({ path: cubePath, allowedMediaRoots: [foreignRoot] })
          return { ok: true }
        } catch (error) {
          return { ok: false, code: (error as { code: string }).code }
        }
      }
    }

    const handlers = createStudioEffectPreviewHandlers({
      getLifecycle: () => misjailed,
      showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] })
    })

    const result = await handlers.load()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('path_outside_allowed_roots')
  })

  it('refuses an invalid cube with its exact reason and imports nothing', async () => {
    const root = temporaryRoot('studio-effect-root-')
    const outside = temporaryRoot('studio-operator-files-')
    const chosen = nodePath.join(outside, 'broken.cube')
    fs.writeFileSync(chosen, 'TITLE "no size"\n0.0 0.0 0.0\n', 'utf8')

    const { lifecycle, applied } = fakeLifecycle(root)
    const handlers = createStudioEffectPreviewHandlers({
      getLifecycle: () => lifecycle,
      showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] })
    })

    const result = await handlers.load()

    expect(result.ok).toBe(false)
    expect(result.code).toBe('missing_lut_3d_size')
    expect(applied).toHaveLength(0)
    // A rejected file must never reach the owned root.
    expect(fs.readdirSync(root)).toHaveLength(0)
  })

  it('treats a dismissed dialog as a no-op rather than a failure', async () => {
    const root = temporaryRoot('studio-effect-root-')
    const { lifecycle, applied } = fakeLifecycle(root)
    const handlers = createStudioEffectPreviewHandlers({
      getLifecycle: () => lifecycle,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    })

    const result = await handlers.load()

    expect(result.ok).toBe(true)
    expect(result.canceled).toBe(true)
    expect(result.state.active).toBe(false)
    expect(applied).toHaveLength(0)
  })

  it('clears the preview by delivering an explicit null', async () => {
    const root = temporaryRoot('studio-effect-root-')
    const outside = temporaryRoot('studio-operator-files-')
    const chosen = nodePath.join(outside, 'look.cube')
    fs.writeFileSync(chosen, identityCube(), 'utf8')

    const { lifecycle, applied } = fakeLifecycle(root)
    const handlers = createStudioEffectPreviewHandlers({
      getLifecycle: () => lifecycle,
      showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] })
    })

    await handlers.load()
    const cleared = await handlers.clear()

    expect(cleared.ok).toBe(true)
    expect(cleared.state.active).toBe(false)
    expect(cleared.state.effectId).toBeNull()
    expect(applied[applied.length - 1]).toBeNull()
  })

  it('recovers the active-LUT label after a restart', async () => {
    const root = temporaryRoot('studio-effect-root-')
    const outside = temporaryRoot('studio-operator-files-')
    const chosen = nodePath.join(outside, 'Teal Orange.cube')
    fs.writeFileSync(chosen, identityCube('teal'), 'utf8')

    const first = fakeLifecycle(root)
    const loaded = await createStudioEffectPreviewHandlers({
      getLifecycle: () => first.lifecycle,
      showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] })
    }).load()
    expect(loaded.ok).toBe(true)
    const effectId = loaded.state.effectId as string

    // A restart: brand-new handlers and lifecycle, no in-memory carry-over,
    // hydrating only the durable effectId the document would replay.
    const restarted: StudioEffectPreviewLifecycleLike = {
      paths: { effectPreviewRoot: root },
      store: { getDocument: () => ({ effectPreview: { effectId } }) },
      setEffectPreview: async () => ({ ok: true })
    }
    const state = await createStudioEffectPreviewHandlers({
      getLifecycle: () => restarted,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    }).getState()

    expect(state.active).toBe(true)
    expect(state.effectId).toBe(effectId)
    expect(state.displayName).toBe('Teal Orange.cube')
  })

  it('reports Studio as unavailable instead of throwing when it is not running', async () => {
    const handlers = createStudioEffectPreviewHandlers({
      getLifecycle: () => null,
      showOpenDialog: async () => {
        throw new Error('the dialog must not open when Studio is unavailable')
      }
    })

    const result = await handlers.load()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('studio_unavailable')
    expect(await handlers.getState()).toEqual({
      active: false,
      displayName: null,
      effectId: null
    })
  })

  /**
   * LOAD-BEARING. Deleting any of the three `ipc.handle` calls in
   * registerStudioEffectPreviewHandlers fails this test, so the registration
   * cannot silently disappear the way the earlier effect-preview seam did.
   */
  it('registers exactly the three pathless channels and routes each one', async () => {
    const root = temporaryRoot('studio-effect-root-')
    const outside = temporaryRoot('studio-operator-files-')
    const chosen = nodePath.join(outside, 'reg.cube')
    fs.writeFileSync(chosen, identityCube(), 'utf8')

    const { lifecycle, applied } = fakeLifecycle(root)
    const registered = new Map<string, (...args: unknown[]) => unknown>()

    registerStudioEffectPreviewHandlers(
      {
        handle: (channel, listener) => {
          registered.set(channel, listener)
        }
      },
      {
        getLifecycle: () => lifecycle,
        showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] })
      }
    )

    expect([...registered.keys()].sort()).toEqual(
      [
        STUDIO_EFFECT_PREVIEW_CLEAR_CHANNEL,
        STUDIO_EFFECT_PREVIEW_LOAD_CHANNEL,
        STUDIO_EFFECT_PREVIEW_STATE_CHANNEL
      ].sort()
    )

    // Invoke through the registered listeners, exactly as ipcMain would — and
    // pass a rogue path to prove the contract ignores renderer-supplied input.
    const loadListener = registered.get(STUDIO_EFFECT_PREVIEW_LOAD_CHANNEL)
    const loaded = (await loadListener?.({}, '/etc/passwd')) as { ok: boolean }
    expect(loaded.ok).toBe(true)
    expect(applied).toHaveLength(1)
    expect(nodePath.dirname(applied[0] as string)).toBe(root)

    const stateListener = registered.get(STUDIO_EFFECT_PREVIEW_STATE_CHANNEL)
    expect(((await stateListener?.({})) as { active: boolean }).active).toBe(true)

    const clearListener = registered.get(STUDIO_EFFECT_PREVIEW_CLEAR_CHANNEL)
    expect(((await clearListener?.({})) as { ok: boolean }).ok).toBe(true)
    expect(applied[applied.length - 1]).toBeNull()
  })

  it('surfaces a delivery failure verbatim instead of claiming success', async () => {
    const root = temporaryRoot('studio-effect-root-')
    const outside = temporaryRoot('studio-operator-files-')
    const chosen = nodePath.join(outside, 'look.cube')
    fs.writeFileSync(chosen, identityCube(), 'utf8')

    const { lifecycle, failNext } = fakeLifecycle(root)
    failNext('stale_base')

    const result = await createStudioEffectPreviewHandlers({
      getLifecycle: () => lifecycle,
      showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] })
    }).load()

    expect(result.ok).toBe(false)
    expect(result.code).toBe('stale_base')
  })
})
