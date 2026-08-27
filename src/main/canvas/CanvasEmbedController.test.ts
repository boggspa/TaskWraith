import { describe, it, expect } from 'vitest'
import {
  CanvasEmbedController,
  type CanvasEmbedRect,
  type EmbeddedViewHandle,
  type EmbedParentWindow
} from './CanvasEmbedController'

class FakeView implements EmbeddedViewHandle {
  bounds: CanvasEmbedRect = { x: 0, y: 0, width: 0, height: 0 }
  visible = true
  closed = false
  readonly webContents = {
    getTitle: () => 'Fake',
    isDestroyed: () => this.closed,
    close: () => {
      this.closed = true
    }
  }
  setBounds(rect: CanvasEmbedRect): void {
    this.bounds = rect
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
}

class FakeParent implements EmbedParentWindow {
  children: EmbeddedViewHandle[] = []
  destroyed = false
  zoom = 1
  isDestroyed(): boolean {
    return this.destroyed
  }
  addChildView(view: EmbeddedViewHandle): void {
    this.children.push(view)
  }
  removeChildView(view: EmbeddedViewHandle): void {
    this.children = this.children.filter((v) => v !== view)
  }
  getZoomFactor(): number {
    return this.zoom
  }
}

function make() {
  const parent = new FakeParent()
  const secondary = new FakeParent()
  const created: FakeView[] = []
  const controller = new CanvasEmbedController({
    getParentWindow: (hostId) => (hostId === 2 ? secondary : parent),
    createView: () => {
      const v = new FakeView()
      created.push(v)
      return v
    }
  })
  return { parent, secondary, created, controller }
}

describe('CanvasEmbedController', () => {
  it('surfaceFor attaches a view hidden off-screen until its pane reports bounds', () => {
    const { parent, created, controller } = make()
    const surface = controller.surfaceFor('c1')({ partition: 'canvas-c1', width: 800, height: 600 })
    expect(parent.children).toHaveLength(1)
    expect(controller.has('c1')).toBe(true)
    expect(created[0].visible).toBe(false)
    expect(created[0].bounds.x).toBeLessThan(-1000)
    controller.setVisible('c1', true)
    expect(created[0].bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    expect(surface.getTitle()).toBe('Fake')
    expect(surface.isDestroyed()).toBe(false)
  })

  it('setBounds positions the view (rounded/clamped) while visible', () => {
    const { created, controller } = make()
    controller.surfaceFor('c1')({ partition: 'p', width: 800, height: 600 })
    controller.setVisible('c1', true)
    controller.setBounds('c1', { x: 10.6, y: 20.4, width: 300.9, height: -5 })
    expect(created[0].bounds).toEqual({ x: 11, y: 20, width: 301, height: 0 })
  })

  it('scales the reported rect by the window zoom factor (CSS-px -> DIP)', () => {
    const { parent, created, controller } = make()
    parent.zoom = 2
    controller.surfaceFor('c1')({ partition: 'p', width: 800, height: 600 })
    controller.setVisible('c1', true)
    controller.setBounds('c1', { x: 10, y: 20, width: 100, height: 50 })
    // The view is positioned in DIP = CSS-px * zoom.
    expect(created[0].bounds).toEqual({ x: 20, y: 40, width: 200, height: 100 })
    // At zoom 1 the rect passes through unchanged.
    parent.zoom = 1
    controller.setBounds('c1', { x: 5, y: 6, width: 7, height: 8 })
    expect(created[0].bounds).toEqual({ x: 5, y: 6, width: 7, height: 8 })
  })

  it('setVisible(false) hides + parks off-screen and ignores live setBounds repaint', () => {
    const { created, controller } = make()
    controller.surfaceFor('c1')({ partition: 'p', width: 800, height: 600 })
    controller.setBounds('c1', { x: 100, y: 100, width: 400, height: 300 })
    controller.setVisible('c1', false)
    expect(created[0].visible).toBe(false)
    expect(created[0].bounds.x).toBeLessThan(-1000) // parked off-screen
    // A bounds update while hidden is remembered but not painted at the live rect.
    controller.setBounds('c1', { x: 5, y: 5, width: 10, height: 10 })
    expect(created[0].bounds.x).not.toBe(5)
    // Re-showing restores the latest remembered rect.
    controller.setVisible('c1', true)
    expect(created[0].bounds).toEqual({ x: 5, y: 5, width: 10, height: 10 })
  })

  it('ignores bounds and visibility writes after the embedded webContents is destroyed', () => {
    const { created, controller } = make()
    controller.surfaceFor('c1')({ partition: 'p', width: 800, height: 600 })
    created[0].bounds = { x: 1, y: 2, width: 3, height: 4 }
    created[0].visible = true
    created[0].closed = true

    expect(() => controller.setBounds('c1', { x: 9, y: 9, width: 9, height: 9 })).not.toThrow()
    expect(() => controller.setVisible('c1', false)).not.toThrow()
    expect(created[0].bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(created[0].visible).toBe(true)
  })

  it('setContentSize updates the tracked size', () => {
    const { created, controller } = make()
    const surface = controller.surfaceFor('c1')({ partition: 'p', width: 800, height: 600 })
    controller.setVisible('c1', true)
    surface.setContentSize(375, 812)
    expect(created[0].bounds).toMatchObject({ width: 375, height: 812 })
  })

  it('detach removes from the parent, closes the webContents, and is idempotent', () => {
    const { parent, created, controller } = make()
    const surface = controller.surfaceFor('c1')({ partition: 'p', width: 1, height: 1 })
    controller.detach('c1')
    expect(parent.children).toHaveLength(0)
    expect(created[0].closed).toBe(true)
    expect(controller.has('c1')).toBe(false)
    expect(surface.isDestroyed()).toBe(true)
    expect(() => controller.detach('c1')).not.toThrow() // idempotent
  })

  it('reparents a live view without destroying it and uses the destination zoom', () => {
    const { parent, secondary, created, controller } = make()
    secondary.zoom = 1.5
    const surface = controller.surfaceFor('c1')({ partition: 'p', width: 200, height: 100 })
    controller.setBounds('c1', { x: 10, y: 20, width: 200, height: 100 })
    controller.setVisible('c1', true)

    controller.reparent('c1', 2)

    expect(parent.children).toHaveLength(0)
    expect(secondary.children).toEqual([created[0]])
    expect(created[0].closed).toBe(false)
    expect(created[0].bounds).toEqual({ x: 15, y: 30, width: 300, height: 150 })
    expect(surface.isDestroyed()).toBe(false)

    controller.detach('c1')
    expect(secondary.children).toHaveLength(0)
  })

  it('binds a newly-created surface directly to its requested renderer host', () => {
    const { parent, secondary, controller } = make()
    controller.surfaceFor('c1', 2)({ partition: 'p', width: 20, height: 10 })
    expect(parent.children).toHaveLength(0)
    expect(secondary.children).toHaveLength(1)
  })

  it('surfaceFor replaces a stale entry for the same id', () => {
    const { parent, created, controller } = make()
    controller.surfaceFor('c1')({ partition: 'p', width: 1, height: 1 })
    controller.surfaceFor('c1')({ partition: 'p', width: 2, height: 2 })
    expect(created).toHaveLength(2)
    expect(created[0].closed).toBe(true) // old view torn down
    expect(parent.children).toEqual([created[1]]) // only the new view attached
  })

  it('detachAll clears every embedded view', () => {
    const { parent, controller } = make()
    controller.surfaceFor('a')({ partition: 'p', width: 1, height: 1 })
    controller.surfaceFor('b')({ partition: 'p', width: 1, height: 1 })
    controller.detachAll()
    expect(parent.children).toHaveLength(0)
    expect(controller.has('a')).toBe(false)
    expect(controller.has('b')).toBe(false)
  })

  it('surface creation throws if the main window is gone', () => {
    const parent = new FakeParent()
    parent.destroyed = true
    const controller = new CanvasEmbedController({
      getParentWindow: () => parent,
      createView: () => new FakeView()
    })
    expect(() => controller.surfaceFor('c1')({ partition: 'p', width: 1, height: 1 })).toThrow(
      /host window is unavailable/
    )
  })
})
