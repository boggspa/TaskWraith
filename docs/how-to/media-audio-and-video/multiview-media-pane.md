# How to: Multiview media pane

**Platform:** Electron

## What it is
A multiview media pane is a multiview cell that hosts an audio or video player detached from the transcript message flow, so you can keep watching or listening while you scroll or work in another pane.

## Where to find it
Click **Detach to pane** (or the pop-out icon) on an audio/video attachment — available on the inline transcript media card, in the chat media dock, and on the image/media preview overlay. The clip opens in an empty multiview pane; if no split layout is active, the view upgrades to a split layout automatically so a pane is available.

<!-- TODO(screenshot): Multiview media pane showing a detached video player -->

## How to use it
1. Find an audio or video attachment in the transcript or the chat media dock and click its **Detach to pane** action.
2. The clip opens in a multiview pane with its own toolbar showing the file name; video plays in a standard player, audio plays in the waveform player.
3. Keep working in another pane — playback continues, but it pauses automatically if the pane scrolls out of view (it never resumes on its own).
4. Click the **×** in the pane's toolbar to close it and stop playback immediately.

## Tips & related
- [Waveform audio player](waveform-audio-player.md) — the player used inside the pane for audio clips.
- [Chat media dock](chat-media-dock.md) — another place you can detach an audio/video attachment from.
- [Canvas multiview pane](../canvas-and-previews/canvas-multiview-pane.md) — the equivalent multiview cell for an embedded web preview.
- [Plus tools menu (multiview layout)](../composer/plus-tools-menu.md) — switch between single and split multiview layouts.
