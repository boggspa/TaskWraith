# How to: Import a 3D scene into Mesh Canvas

**Platform:** Electron

## What it is

Mesh Canvas is TaskWraith's local, declarative 3D viewer. A human can import an
exported model or a complete exported scene into the current chat, then an
appropriately granted participant can inspect, arrange, edit, and present that
chat-owned scene. Imported source paths never become agent tools or renderer
filesystem URLs: TaskWraith copies the approved export into its private local
asset vault first.

## Where to find it

Open the **Mesh Canvas** dock for a saved chat. The dock toolbar has two import
actions:

- **Import 3D scene or model** selects one `.glb`, `.gltf`, or `.obj` root.
- **Import scene package** selects a folder containing
  `taskwraith.mesh-scene.json`.

<!-- screenshot-pending: Mesh Canvas dock showing both import actions -->

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

The imported scene is owned by the selected chat. A participant needs the
normal Mesh Canvas grant for that run to use the provider-agnostic Mesh Canvas
tools; grants belong to participants/runs, not to a prior provider session.
Those tools operate on the durable declarative scene and can present it to the
user. They never receive the original folder path or the vault access token.

## Tips & related

- [Canvas multiview pane](canvas-multiview-pane.md) — a separate live web-preview surface.
- [Canvas composer button](canvas-composer-button.md) — opens a web canvas from the composer.
- [Approvals & Permissions](../approvals-and-permissions/) — how task capabilities and permissions are surfaced.
