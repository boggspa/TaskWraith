# Codex Terra — Mesh Canvas adapter-layer work session

This marker means an active Codex Terra session is implementing the safe Mesh Canvas adapter layer in this checkout. It will be deleted when the adapter work is complete.

Scope: define a declarative scene-package manifest, resolve it only in Electron main, copy only declared scene files into the private vault, then add native folder/package selection and optional DCC exporter adapters without executing project code or plugins.

Commits:

- 5ebb3411e — declarative scene-package manifest foundation.
- 52e1fd3ba — closed-bundle resolver, vault import, and multi-root scene projection.
- Pending — native scene-package picker and chat-owned package-import IPC.
