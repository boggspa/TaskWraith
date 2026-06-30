# How to: Waveform audio player

**Platform:** Both

## What it is
The waveform audio player is the inline control TaskWraith uses for every audio attachment: a canvas-drawn waveform strip with a play/pause button, a moving playhead, and a time label, instead of a native browser audio control.

## Where to find it
It appears wherever an audio attachment is rendered: inline in the transcript under a message, in the chat media dock (the right-side panel listing uploads and paths), and in a detached Multiview media pane when you pop a clip out of the transcript flow.

<!-- TODO(screenshot): Waveform audio player in the transcript or media pane -->

## How to use it
1. Click the play button on the waveform strip to start playback; click again (or press Enter while the strip is focused) to pause.
2. Click anywhere on the waveform, or drag across it, to seek to that point.
3. With the strip focused, press the Left/Right arrow keys to skip backward or forward 5 seconds.
4. If the player is in a Multiview pane or media dock entry that scrolls off-screen, playback pauses automatically; press play again to resume.

## Tips & related
- [Inline transcript media](inline-transcript-media.md) — the per-message strip that hosts this player in the transcript.
- [Chat media dock](chat-media-dock.md) — the right-side panel where this player also appears for audio uploads.
- [Multiview media pane](multiview-media-pane.md) — pop an audio attachment into its own detached pane using this same player.
