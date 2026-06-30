# How to: iOS media playback

**Platform:** iOS

## What it is
Audio and video attachments in an iOS transcript play back by streaming directly from your Mac over the encrypted bridge, instead of downloading the whole file first — tap a clip and it starts playing in seconds, even for large recordings.

## Where to find it
Open any chat that has audio or video attachments. Each transcript row with media shows a horizontal strip of tiles below the message; video and audio tiles carry a play button. Tapping one opens a player sheet over the thread.

<!-- TODO(screenshot): iOS media playback in the companion app -->

## How to use it
1. In a thread, find a message with a media strip and locate a video (film icon) or audio (waveform icon) tile.
2. Tap the tile's play button to open the player sheet — playback begins automatically.
3. For video, use the standard system video controls (scrub, pause, fullscreen) inside the sheet.
4. For audio, the sheet shows the clip's poster/waveform image above a compact transport bar.
5. Tap **Done** to close the sheet; playback stops and the streamed connection is released.

## Tips & related
- Image attachments in the same strip behave differently — tapping one fetches and shows the full picture instead of streaming; see [Inline transcript media](inline-transcript-media.md).
- Tiles show a duration badge and file size when available, so you can gauge a clip's length before opening it.
- Streaming pulls the asset in chunks from your paired Mac, so playback requires an active bridge connection to the host.
