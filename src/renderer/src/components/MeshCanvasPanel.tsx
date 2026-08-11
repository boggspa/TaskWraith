/**
 * Mesh Canvas dock viewer. The renderer receives only declarative scene data
 * plus token-gated twmesh:// asset URLs; it never receives vault/source paths
 * and never evaluates provider-supplied scene code.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MESH_CANVAS_NEEDS_SAVED_CHAT,
  hasMeshCanvasChatAuthority,
  meshCanvasIssueMessage
} from '../lib/meshCanvasAvailability'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import {
  buildMeshTopologyBoneGeometry,
  buildMeshTopologyEdgeGeometry,
  buildMeshTopologySurfaceGeometry,
  buildMeshTopologyVertexGeometry
} from '../lib/meshTopologyRender'
import type {
  MeshPbrMaterial,
  MeshSceneNode,
  MeshSceneSummary,
  MeshSceneView
} from '../../../shared/meshScene'

const BLOCKED_ASSET_URL = 'twmesh://asset/invalid/invalid/blocked'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function toMeshSceneSummary(value: unknown): MeshSceneSummary | null {
  if (!isRecord(value) || typeof value.sceneId !== 'string' || !value.sceneId) return null
  return {
    sceneId: value.sceneId,
    title: typeof value.title === 'string' && value.title ? value.title : 'Mesh scene',
    nodeCount: typeof value.nodeCount === 'number' ? value.nodeCount : 0,
    importCount: typeof value.importCount === 'number' ? value.importCount : 0,
    primitiveCount: typeof value.primitiveCount === 'number' ? value.primitiveCount : 0,
    editableCount: typeof value.editableCount === 'number' ? value.editableCount : 0,
    backgroundColor: typeof value.backgroundColor === 'string' ? value.backgroundColor : '#171a21',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    ...(typeof value.presentedAt === 'string' ? { presentedAt: value.presentedAt } : {})
  }
}

function isMeshSceneView(value: unknown): value is MeshSceneView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.nodes) &&
    isRecord(value.assetUrls) &&
    isRecord(value.modelUrls) &&
    isRecord(value.topologies) &&
    isRecord(value.camera) &&
    isRecord(value.lighting)
  )
}

function applyTransform(object: THREE.Object3D, node: MeshSceneNode): void {
  object.position.set(
    node.transform.position.x,
    node.transform.position.y,
    node.transform.position.z
  )
  object.rotation.set(
    THREE.MathUtils.degToRad(node.transform.rotation.x),
    THREE.MathUtils.degToRad(node.transform.rotation.y),
    THREE.MathUtils.degToRad(node.transform.rotation.z)
  )
  object.scale.set(node.transform.scale.x, node.transform.scale.y, node.transform.scale.z)
  object.visible = node.visible
  object.name = node.name
}

function materialFor(
  specification: MeshPbrMaterial | undefined,
  textureLoader: THREE.TextureLoader,
  assetUrls: Readonly<Record<string, string>>
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: specification?.baseColor ?? '#b9bec8',
    metalness: specification?.metallic ?? 0,
    roughness: specification?.roughness ?? 0.6,
    emissive: specification?.emissive ?? '#000000',
    opacity: specification?.opacity ?? 1,
    transparent: (specification?.opacity ?? 1) < 1,
    side: specification?.doubleSided ? THREE.DoubleSide : THREE.FrontSide
  })
  const textureUrl = specification?.textureAssetId
    ? assetUrls[specification.textureAssetId]
    : undefined
  if (textureUrl) {
    textureLoader.load(
      textureUrl,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        material.map = texture
        material.needsUpdate = true
      },
      undefined,
      () => undefined
    )
  }
  return material
}

function applyMaterialOverride(
  object: THREE.Object3D,
  specification: MeshPbrMaterial | undefined,
  textureLoader: THREE.TextureLoader,
  assetUrls: Readonly<Record<string, string>>
): void {
  if (!specification) return
  object.traverse((candidate) => {
    if (!(candidate instanceof THREE.Mesh)) return
    const original = Array.isArray(candidate.material) ? candidate.material[0] : candidate.material
    const pbr =
      original instanceof THREE.MeshStandardMaterial
        ? original.clone()
        : new THREE.MeshStandardMaterial({
            color:
              original && 'color' in original && original.color instanceof THREE.Color
                ? original.color
                : '#b9bec8',
            map:
              original && 'map' in original && original.map instanceof THREE.Texture
                ? original.map
                : null
          })
    if (specification.baseColor) pbr.color.set(specification.baseColor)
    if (specification.emissive) pbr.emissive.set(specification.emissive)
    if (specification.metallic !== undefined) pbr.metalness = specification.metallic
    if (specification.roughness !== undefined) pbr.roughness = specification.roughness
    if (specification.opacity !== undefined) {
      pbr.opacity = specification.opacity
      pbr.transparent = specification.opacity < 1
    }
    if (specification.doubleSided !== undefined) {
      pbr.side = specification.doubleSided ? THREE.DoubleSide : THREE.FrontSide
    }
    const textureUrl = specification.textureAssetId
      ? assetUrls[specification.textureAssetId]
      : undefined
    if (textureUrl) {
      textureLoader.load(
        textureUrl,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace
          pbr.map = texture
          pbr.needsUpdate = true
        },
        undefined,
        () => undefined
      )
    }
    candidate.material = pbr
  })
}

function primitiveGeometry(
  node: Extract<MeshSceneNode, { kind: 'primitive' }>
): THREE.BufferGeometry {
  const primitive = node.primitive
  switch (primitive) {
    case 'sphere':
      return new THREE.SphereGeometry(1, 48, 32)
    case 'plane':
      return new THREE.PlaneGeometry(2, 2)
    case 'cylinder':
      return new THREE.CylinderGeometry(0.8, 0.8, 2, 48)
    case 'torus':
      return new THREE.TorusGeometry(1, 0.32, 24, 64)
    default:
      return new THREE.BoxGeometry(1.6, 1.6, 1.6)
  }
}

function vaultUrl(baseUrl: string, reference: string): string | null {
  try {
    const resolved = new URL(reference.trim().replace(/^['"]|['"]$/g, ''), baseUrl)
    return resolved.protocol === 'twmesh:' && resolved.hostname === 'asset'
      ? resolved.toString()
      : null
  } catch {
    return null
  }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((candidate) => {
    if (
      !(
        candidate instanceof THREE.Mesh ||
        candidate instanceof THREE.Line ||
        candidate instanceof THREE.Points
      )
    ) {
      return
    }
    candidate.geometry.dispose()
    const materials = Array.isArray(candidate.material) ? candidate.material : [candidate.material]
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && typeof value === 'object' && value instanceof THREE.Texture) {
          const texture = value as THREE.Texture
          texture.dispose()
        }
      }
      material.dispose()
    }
  })
}

interface MeshSceneViewerProps {
  view: MeshSceneView
  topologyDisplay: MeshTopologyDisplayOptions
  onIssue: (message: string | null) => void
}

export interface MeshTopologyDisplayOptions {
  surface: boolean
  wireframe: boolean
  vertices: boolean
  skeleton: boolean
}

const DEFAULT_TOPOLOGY_DISPLAY: MeshTopologyDisplayOptions = Object.freeze({
  surface: true,
  wireframe: false,
  vertices: false,
  skeleton: true
})

export function MeshSceneViewer({ view, topologyDisplay, onIssue }: MeshSceneViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let disposed = false
    let frame = 0
    let reportTimer: number | null = null
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    host.replaceChildren(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(view.backgroundColor)
    const camera = new THREE.PerspectiveCamera(view.camera.fieldOfView, 1, 0.01, 100_000)
    camera.position.set(view.camera.position.x, view.camera.position.y, view.camera.position.z)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(view.camera.target.x, view.camera.target.y, view.camera.target.z)
    controls.update()

    const hemisphere = new THREE.HemisphereLight(
      view.lighting.environment === 'sunset' ? '#ffb06e' : '#dbe8ff',
      view.lighting.environment === 'sunset' ? '#36211c' : '#202735',
      Math.max(0.05, view.lighting.intensity * 0.85)
    )
    const key = new THREE.DirectionalLight(
      view.lighting.environment === 'sunset' ? '#ffd2a3' : '#ffffff',
      Math.max(0.05, view.lighting.intensity * 1.5)
    )
    key.position.set(5, 8, 6)
    scene.add(hemisphere, key, new THREE.GridHelper(20, 20, '#3d4758', '#2a303a'))

    const textureLoader = new THREE.TextureLoader()
    const reportIssue = (message: string): void => {
      if (disposed) return
      if (reportTimer !== null) window.clearTimeout(reportTimer)
      reportTimer = window.setTimeout(() => onIssue(message), 80)
    }
    const addImported = (
      node: Extract<MeshSceneNode, { kind: 'import' }>,
      object: THREE.Object3D
    ) => {
      if (disposed) {
        disposeObject(object)
        return
      }
      applyTransform(object, node)
      applyMaterialOverride(object, node.material, textureLoader, view.assetUrls)
      scene.add(object)
    }
    const managerFor = (entryUrl: string) => {
      const manager = new THREE.LoadingManager()
      manager.setURLModifier((value) => vaultUrl(entryUrl, value) ?? BLOCKED_ASSET_URL)
      return manager
    }

    for (const node of view.nodes) {
      if (node.kind === 'primitive') {
        const mesh = new THREE.Mesh(
          primitiveGeometry(node),
          materialFor(node.material, textureLoader, view.assetUrls)
        )
        applyTransform(mesh, node)
        scene.add(mesh)
        continue
      }
      if (node.kind === 'editable') {
        const topology = view.topologies[node.topologyId]
        if (!topology || topology.revision !== node.topologyRevision) {
          reportIssue(`The editable topology for “${node.name}” is unavailable or out of sync.`)
          continue
        }
        const group = new THREE.Group()
        group.userData.topologyRevision = topology.revision
        if (topologyDisplay.surface) {
          const surface = buildMeshTopologySurfaceGeometry(topology)
          if ((surface.geometry.getIndex()?.count ?? 0) > 0) {
            group.add(
              new THREE.Mesh(
                surface.geometry,
                materialFor(node.material, textureLoader, view.assetUrls)
              )
            )
          } else {
            surface.geometry.dispose()
          }
        }
        if (topologyDisplay.wireframe && topology.edges.length > 0) {
          group.add(
            new THREE.LineSegments(
              buildMeshTopologyEdgeGeometry(topology),
              new THREE.LineBasicMaterial({
                color: '#63c7ff',
                transparent: true,
                opacity: 0.9
              })
            )
          )
        }
        if (topologyDisplay.vertices && topology.vertices.length > 0) {
          group.add(
            new THREE.Points(
              buildMeshTopologyVertexGeometry(topology),
              new THREE.PointsMaterial({
                color: '#f6fbff',
                size: 0.055,
                sizeAttenuation: true
              })
            )
          )
        }
        if (topologyDisplay.skeleton && topology.bones.length > 0) {
          group.add(
            new THREE.LineSegments(
              buildMeshTopologyBoneGeometry(topology),
              new THREE.LineBasicMaterial({
                color: '#ffb454',
                transparent: true,
                opacity: 0.95,
                depthTest: false
              })
            )
          )
        }
        applyTransform(group, node)
        scene.add(group)
        continue
      }
      const entryUrl = view.modelUrls[node.id] ?? view.assetUrls[node.assetId]
      if (!entryUrl) {
        reportIssue(`The asset for “${node.name}” is no longer available.`)
        continue
      }
      if (node.format === 'glb' || node.format === 'gltf') {
        new GLTFLoader(managerFor(entryUrl)).load(
          entryUrl,
          (gltf) => addImported(node, gltf.scene),
          undefined,
          () => reportIssue(`Could not load “${node.name}”.`)
        )
        continue
      }

      // OBJLoader does not resolve an `mtllib` declaration itself. Fetching the
      // private OBJ text lets us load its vault-local MTL with a URL-modified
      // manager, preserving Wavefront materials/textures while denying URLs that
      // point anywhere outside twmesh://.
      void fetch(entryUrl)
        .then(async (response) => {
          if (!response.ok) throw new Error('OBJ asset unavailable')
          const source = await response.text()
          const mtlReference = /^\s*mtllib\s+(.+?)\s*$/im.exec(source)?.[1]
          const mtlUrl = mtlReference ? vaultUrl(entryUrl, mtlReference) : null
          if (!mtlUrl) return { source, materials: null }
          return await new Promise<{
            source: string
            materials: ReturnType<MTLLoader['parse']> | null
          }>((resolve) => {
            const loader = new MTLLoader(managerFor(mtlUrl))
            loader.setResourcePath(mtlUrl.slice(0, mtlUrl.lastIndexOf('/') + 1))
            loader.load(
              mtlUrl,
              (materials) => resolve({ source, materials }),
              undefined,
              () => resolve({ source, materials: null })
            )
          })
        })
        .then(({ source, materials }) => {
          if (disposed) return
          if (materials) materials.preload()
          const loader = new OBJLoader(managerFor(entryUrl))
          if (materials) loader.setMaterials(materials)
          addImported(node, loader.parse(source))
        })
        .catch(() => reportIssue(`Could not load “${node.name}”.`))
    }

    const resize = (): void => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(host)
    window.addEventListener('resize', resize)
    resize()
    const render = (): void => {
      if (disposed) return
      controls.update()
      renderer.render(scene, camera)
      frame = window.requestAnimationFrame(render)
    }
    render()

    return () => {
      disposed = true
      if (frame) window.cancelAnimationFrame(frame)
      if (reportTimer !== null) window.clearTimeout(reportTimer)
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      controls.dispose()
      for (const child of [...scene.children]) disposeObject(child)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [onIssue, topologyDisplay, view])

  return <div ref={hostRef} className="mesh-scene-viewer" aria-label={`${view.title} 3D viewer`} />
}

export interface MeshCanvasPanelProps {
  chatId: string
  onDismiss: () => void
}

export interface MeshCanvasPanelStatusProps {
  hasView: boolean
  hasScenes: boolean
  issue: string | null
}

export function MeshCanvasPanelStatus({ hasView, hasScenes, issue }: MeshCanvasPanelStatusProps) {
  if (issue) {
    return (
      <div className="mesh-canvas-issue" role="alert">
        {issue}
      </div>
    )
  }
  if (hasView) return null
  return (
    <div className="mesh-canvas-empty">
      {hasScenes
        ? 'Choose a scene to load its local 3D preview.'
        : 'No Mesh Canvas scene has been created in this chat yet.'}
    </div>
  )
}

export function MeshCanvasPanel({ chatId, onDismiss }: MeshCanvasPanelProps) {
  const [scenes, setScenes] = useState<readonly MeshSceneSummary[]>([])
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null)
  const [view, setView] = useState<MeshSceneView | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [sceneRevision, setSceneRevision] = useState(0)
  const [topologyDisplay, setTopologyDisplay] =
    useState<MeshTopologyDisplayOptions>(DEFAULT_TOPOLOGY_DISPLAY)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.api?.meshCanvas
    if (!api) return
    try {
      const canonical = await hasMeshCanvasChatAuthority(chatId)
      if (chatIdRef.current !== chatId) return
      if (!canonical) {
        setScenes([])
        setActiveSceneId(null)
        setView(null)
        setIssue(MESH_CANVAS_NEEDS_SAVED_CHAT)
        return
      }
      const next = (await api.listForChat(chatId))
        .map(toMeshSceneSummary)
        .filter((scene): scene is MeshSceneSummary => scene !== null)
      if (chatIdRef.current !== chatId) return
      setScenes(next)
      setActiveSceneId((current) => {
        if (current && next.some((scene) => scene.sceneId === current)) return current
        return next.find((scene) => scene.presentedAt)?.sceneId ?? next[0]?.sceneId ?? null
      })
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(meshCanvasIssueMessage(error, 'Mesh Canvas could not be refreshed.'))
      }
    }
  }, [chatId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const api = window.api?.meshCanvas
    if (!api?.onEvent) return
    let timer: number | null = null
    const off = api.onEvent((event) => {
      const record = event as { chatId?: unknown; kind?: unknown; sceneId?: unknown } | null
      if (!record || record.chatId !== chatId) return
      if (record.kind === 'scene.presented' && typeof record.sceneId === 'string') {
        setActiveSceneId(record.sceneId)
      }
      // Keep the visible Three scene in sync with a tool/graph update even
      // when its selected tab id stays the same. The main service emits only
      // after persisting the resolved graph transaction.
      setSceneRevision((revision) => revision + 1)
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void refresh()
      }, 100)
    })
    return () => {
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [chatId, refresh])

  useEffect(() => {
    const api = window.api?.meshCanvas
    if (!api || !activeSceneId) {
      setView(null)
      return
    }
    let cancelled = false
    setIssue(null)
    void api
      .view(chatId, activeSceneId)
      .then((value) => {
        if (cancelled || chatIdRef.current !== chatId) return
        if (!isMeshSceneView(value)) throw new Error('The Mesh Canvas scene is unavailable.')
        setView(value)
      })
      .catch((error) => {
        if (!cancelled && chatIdRef.current === chatId) {
          setView(null)
          setIssue(meshCanvasIssueMessage(error, 'The Mesh Canvas scene is unavailable.'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeSceneId, chatId, sceneRevision])

  const importUserModel = async (): Promise<void> => {
    const api = window.api?.meshCanvas
    if (!api?.importUserModel || importing) return
    setImporting(true)
    setIssue(null)
    try {
      const imported = await api.importUserModel(chatId)
      if (imported.canceled) return
      const summary = toMeshSceneSummary(imported.scene)
      await refresh()
      if (summary) setActiveSceneId(summary.sceneId)
    } catch (error) {
      setIssue(meshCanvasIssueMessage(error, 'Could not import the selected 3D scene or model.'))
    } finally {
      setImporting(false)
    }
  }

  const importUserScenePackage = async (): Promise<void> => {
    const api = window.api?.meshCanvas
    if (!api?.importUserScenePackage || importing) return
    setImporting(true)
    setIssue(null)
    try {
      const imported = await api.importUserScenePackage(chatId)
      if (imported.canceled) return
      const summary = toMeshSceneSummary(imported.scene)
      await refresh()
      if (summary) setActiveSceneId(summary.sceneId)
    } catch (error) {
      setIssue(
        meshCanvasIssueMessage(error, 'Could not import the selected Mesh Canvas scene package.')
      )
    } finally {
      setImporting(false)
    }
  }

  const dismiss = async (): Promise<void> => {
    if (view?.presentation) {
      const api = window.api?.meshCanvas
      if (!api || !activeSceneId) return
      try {
        await api.closePresentation(chatId, activeSceneId)
        await refresh()
      } catch (error) {
        setIssue(meshCanvasIssueMessage(error, 'Could not close the Mesh Canvas presentation.'))
        return
      }
    }
    onDismiss()
  }

  const toggleTopologyDisplay = (key: keyof MeshTopologyDisplayOptions): void => {
    setTopologyDisplay((current) => ({ ...current, [key]: !current[key] }))
  }

  const editableNodes = view?.nodes.filter((node) => node.kind === 'editable') ?? []
  const editableVertexCount = editableNodes.reduce(
    (total, node) => total + node.topologySummary.vertexCount,
    0
  )
  const editableFaceCount = editableNodes.reduce(
    (total, node) => total + node.topologySummary.faceCount,
    0
  )

  return (
    <section className="mesh-canvas-panel" aria-label="Mesh Canvas">
      <div className="mesh-canvas-toolbar">
        <div>
          <div className="mesh-canvas-title">Mesh Canvas</div>
          <div className="mesh-canvas-subtitle">
            Human and agent-built 3D scenes stay local to this chat.
          </div>
        </div>
        <div className="mesh-canvas-actions">
          <button
            type="button"
            className="mesh-canvas-import"
            onClick={() => void importUserModel()}
            disabled={importing}
          >
            {importing ? 'Opening picker…' : 'Import 3D scene or model'}
          </button>
          <button
            type="button"
            className="mesh-canvas-import"
            title="Choose a folder containing taskwraith.mesh-scene.json"
            onClick={() => void importUserScenePackage()}
            disabled={importing}
          >
            {importing ? 'Opening picker…' : 'Import scene package'}
          </button>
          <button
            type="button"
            className="mesh-canvas-dismiss"
            title="Dismiss Mesh Canvas without deleting the scene or its files"
            onClick={() => void dismiss()}
          >
            Dismiss
          </button>
        </div>
      </div>

      {scenes.length > 0 && (
        <div className="mesh-canvas-tabs" role="tablist" aria-label="Mesh scenes">
          {scenes.map((scene) => (
            <button
              key={scene.sceneId}
              type="button"
              role="tab"
              aria-selected={activeSceneId === scene.sceneId}
              className={`mesh-canvas-tab${activeSceneId === scene.sceneId ? ' is-active' : ''}`}
              onClick={() => setActiveSceneId(scene.sceneId)}
            >
              <span>{scene.title}</span>
              {scene.presentedAt && <i aria-label="Presented">●</i>}
            </button>
          ))}
        </div>
      )}

      {view ? (
        <div className="mesh-canvas-stage">
          {editableNodes.length > 0 && (
            <div className="mesh-canvas-topology-display" aria-label="Topology display">
              {(
                [
                  ['surface', 'Surface'],
                  ['wireframe', 'Edges'],
                  ['vertices', 'Vertices'],
                  ['skeleton', 'Rig']
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={topologyDisplay[key]}
                  className={topologyDisplay[key] ? 'is-active' : ''}
                  onClick={() => toggleTopologyDisplay(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <MeshSceneViewer view={view} topologyDisplay={topologyDisplay} onIssue={setIssue} />
          <div className="mesh-canvas-caption">
            {view.nodes.length} {view.nodes.length === 1 ? 'object' : 'objects'}
            {editableNodes.length > 0 &&
              ` · ${editableNodes.length} editable · ${editableVertexCount.toLocaleString()} vertices · ${editableFaceCount.toLocaleString()} faces`}{' '}
            · drag to orbit · scroll to zoom
          </div>
        </div>
      ) : null}

      <MeshCanvasPanelStatus hasView={Boolean(view)} hasScenes={scenes.length > 0} issue={issue} />
    </section>
  )
}
