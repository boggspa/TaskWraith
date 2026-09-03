# How to: Create and edit geometry in Mesh Canvas

**Platform:** Electron

## What it is

Mesh Canvas is TaskWraith's built-in 3D scene surface. Agents can create a scene from simple shapes without an existing model, turn a shape or imported object into editable geometry, and then change its vertices, edges, faces, UVs, sculpted form, bones, weights, and poses. You can also import an exported model or complete scene into the current chat.

Scenes and editable geometry belong to the chat, so solo agents and Ensemble participants see the same current version. Imported files are copied into TaskWraith's private local asset store first — the import never rewrites your original file.

## Where to find it

Open the **Mesh Canvas** dock for a saved chat. The dock toolbar has two import
actions:

- **Import 3D scene or model** selects one `.glb`, `.gltf`, or `.obj` root.
- **Import scene package** selects a folder containing
  `taskwraith.mesh-scene.json`.

<!-- screenshot-pending: Mesh Canvas dock showing both import actions -->

## Create and collaborate without an import

Ask an agent to create a Mesh Canvas scene and add a box, sphere, plane,
cylinder, or torus. The agent can arrange the shapes and set their materials,
then convert one into editable geometry when it needs to change its internal
shape:

| Tool | What it does |
| --- | --- |
| `mesh_topology_convert` | Converts one primitive or imported node into editable, stable-id topology. Conversion completes before the scene switches to the editable copy. |
| `mesh_topology_inspect` | Reads bounded pages of the current summary, vertices, edges, faces and per-loop UVs, or bones. It also returns the current geometry revision. |
| `mesh_topology_edit` | Applies one atomic, revision-checked batch of topology, UV, sculpt, or rig operations. |

The edit surface supports creating, moving, merging, and deleting vertices;
creating/deleting, extruding, insetting, and subdividing faces; splitting and
collapsing edges; marking seams and creases; setting loop UVs or planar, box,
cylindrical, and spherical projection; draw, inflate, smooth, flatten, pinch,
and grab sculpt strokes; and editing bones, vertex weights, and poses. An agent
can also replace the complete internal vertex/face geometry of an editable node
in one validated transaction.

Every change includes an `expectedRevision` and a `clientMutationId`. If two
participants read version 7, the first accepted edit creates version 8;
the second gets a conflict instead of silently overwriting it. That participant
must re-read version 8, reconcile the change, and retry.

The viewer renders editable faces directly and offers **Surface**, **Edges**,
**Vertices**, and **Rig** overlays. Its caption shows live editable-object,
vertex, and face counts.

## Import one exported root

Use **Import 3D scene or model** for a self-contained GLB or one exported
glTF/OBJ root. TaskWraith copies the root and its local, declared sidecars into
the private vault: glTF buffers/images, or OBJ material libraries/textures.
This is the simplest option for most Blender, Unity, Maya, 3ds Max, and Cinema
4D workflows when the DCC can export a single GLB.

## Import a complete scene package

Use **Import scene package** when an export needs multiple roots or a known
directory layout. Select the package **folder**, not a native DCC project. Its
root must contain this data-only manifest:

```json
{
  "schemaVersion": 1,
  "kind": "taskwraith.mesh-scene-package",
  "title": "Gallery export",
  "roots": [
    { "path": "scene/gallery.glb", "name": "Gallery" },
    { "path": "props/sign.obj", "name": "Sign" }
  ],
  "files": [
    "scene/gallery.glb",
    "props/sign.obj",
    "props/sign.mtl",
    "props/sign.png"
  ]
}
```

`roots` may contain `.glb`, `.gltf`, or `.obj` files; each becomes an imported
object in one Mesh Canvas scene. `files` is the exact allowlist copied into the
vault. Paths use forward slashes and are relative to the selected folder.
For a JSON glTF, include every referenced buffer and image. For an OBJ, include
every referenced MTL and texture.

The import rejects traversal, remote/unsafe sidecar references, symlinks,
undeclared dependencies, and packages larger than 512 MiB. Embedded glTF data
URIs are fine because they have no sidecar file. Extra exporter metadata can be
kept in the JSON; TaskWraith ignores it.

## DCC adapter boundary

TaskWraith deliberately does not open or execute `.blend`, Unity project,
`.ma`/`.mb`, `.max`, or Cinema 4D project files. It does not run DCC plugins,
editor binaries, project scripts, or extensions while importing. Instead:

| Source application | Recommended handoff |
| --- | --- |
| Blender | Export a single GLB for a compact scene, or glTF + sidecars into an export-only package folder. |
| Unity | Use a trusted glTF/GLB exporter to create an export-only folder; do not select the Unity project or `Assets` tree. |
| Maya / 3ds Max | Export GLB/glTF with textures, then package the exported files if there is more than one root. |
| Cinema 4D / Maxon tools | Export GLB/glTF with textures, then package the exported files if there is more than one root. |

An exporter or integration can target the manifest above without gaining any
runtime authority inside TaskWraith. Keep the package folder export-only and
list only the scene roots and their required sidecars.

## After import

The imported scene is owned by the selected chat. An agent can leave an import
as an opaque display object or convert a selected object to editable topology.
TaskWraith rejects conversion features it cannot preserve safely, including
compressed geometry, morph targets, and animation payloads, rather than
silently discarding them. The private editable copy can be rewritten while the
workspace export remains byte-for-byte unchanged.

## Permissions

Mesh authoring follows the same permission presets as everything else:

- **Ask** and **Plan** ask for approval before each change to the scene.
- **Accept Edits**, **Full WS Access**, and **Full Access** treat the selected preset as approval for the run and do not ask again per change.
- An explicit Mesh Canvas **Deny** blocks scene changes in every preset.

Permissions belong to each participant and run. If a provider seat was started before Mesh tools were added, start a fresh session with that provider to pick them up.

Tools work on the saved scene and never receive the private vault access token. Importing a model from your files needs a workspace-backed chat; creating shapes and editing geometry also works in a saved global chat.

## Tips & related

- [Canvas multiview pane](canvas-multiview-pane.md) — a separate live web-preview surface.
- [Canvas composer button](canvas-composer-button.md) — opens a web canvas from the composer.
- [Approvals & Permissions](../approvals-and-permissions/) — how task capabilities and permissions are surfaced.
