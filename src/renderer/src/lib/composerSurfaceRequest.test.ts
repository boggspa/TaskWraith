import { describe, it, expect } from 'vitest'
import {
  COMPOSER_SURFACE_IDS,
  composerSurfaceOpenSignal,
  nextComposerSurfaceRequest,
  type ComposerSurfaceRequest
} from './composerSurfaceRequest'

describe('composerSurfaceRequest', () => {
  describe('nextComposerSurfaceRequest', () => {
    it('starts at nonce 1 so the inert 0 signal is never a real request', () => {
      expect(nextComposerSurfaceRequest(null, 'plan')).toEqual({ surface: 'plan', nonce: 1 })
      expect(nextComposerSurfaceRequest(undefined, 'canvas')).toEqual({
        surface: 'canvas',
        nonce: 1
      })
    })

    it('advances the nonce when the SAME surface is requested twice', () => {
      // The reason this is a nonce and not a boolean: running /plan, closing the
      // popover by hand, then running /plan again must re-open it. A stable
      // value would leave the second invocation doing nothing.
      const first = nextComposerSurfaceRequest(null, 'plan')
      const second = nextComposerSurfaceRequest(first, 'plan')
      expect(second.nonce).toBeGreaterThan(first.nonce)
      expect(second.surface).toBe('plan')
    })

    it('keeps the nonce climbing across different surfaces', () => {
      const plan = nextComposerSurfaceRequest(null, 'plan')
      const canvas = nextComposerSurfaceRequest(plan, 'canvas')
      const planAgain = nextComposerSurfaceRequest(canvas, 'plan')
      expect(canvas.nonce).toBe(2)
      expect(planAgain.nonce).toBe(3)
    })
  })

  describe('composerSurfaceOpenSignal', () => {
    it('returns 0 when there is no request at all', () => {
      expect(composerSurfaceOpenSignal(null, 'plan')).toBe(0)
      expect(composerSurfaceOpenSignal(undefined, 'plan')).toBe(0)
    })

    it('returns 0 for every surface the request does not name', () => {
      const request = nextComposerSurfaceRequest(null, 'plan')
      for (const surface of COMPOSER_SURFACE_IDS) {
        if (surface === 'plan') continue
        expect(composerSurfaceOpenSignal(request, surface)).toBe(0)
      }
    })

    it('returns the nonce for the requested surface', () => {
      const request = nextComposerSurfaceRequest(
        nextComposerSurfaceRequest(null, 'canvas'),
        'blackboard'
      )
      expect(composerSurfaceOpenSignal(request, 'blackboard')).toBe(2)
    })

    it('treats a non-positive nonce as inert', () => {
      // Defensive: a rehydrated or hand-built request must never be able to
      // fire an open on mount.
      const bogus: ComposerSurfaceRequest = { surface: 'terminal', nonce: 0 }
      expect(composerSurfaceOpenSignal(bogus, 'terminal')).toBe(0)
    })

    it('covers every surface the icon row exposes', () => {
      expect([...COMPOSER_SURFACE_IDS].sort()).toEqual([
        'blackboard',
        'canvas',
        'multiview',
        'plan',
        'schedule',
        'terminal'
      ])
    })
  })
})
