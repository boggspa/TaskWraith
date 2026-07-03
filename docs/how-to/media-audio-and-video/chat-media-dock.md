# How to: Chat media dock

**Platform:** Electron

## What it is
The Chat media dock is a right-dock panel listing every image, audio clip, video, and file/folder path attached to or generated in the current chat, with a larger preview of whichever item you select.

## Where to find it
Click the media icon among the corner controls above the transcript (it shows a count badge when the chat has media) to open the **Media** tab in the right dock. The dock lists all items for the current chat; selecting one shows its preview, badges (duration/size/codec), and an actions menu (Open in Finder, Copy path, Save as, and Detach to pane for audio/video).

<!-- screenshot-pending: Chat media dock in the right panel -->

## How to use it
1. Click the media corner button above the transcript to open the dock.
2. Pick an item from the list on the right to preview it on the left — images, audio (waveform player), and video all preview inline.
3. Use the actions menu (⋯) on the preview to open the file in Finder, copy its path, or save it elsewhere.
4. For audio/video items, click **Detach** to pop the player out into its own Multiview pane.
5. Click **Close** to dismiss the dock.

## Tips & related
- [Inline transcript media](./inline-transcript-media.md) — the same media also appears as cards directly in the transcript.
- [Multiview media pane](./multiview-media-pane.md) — where detached audio/video players land.
- [Waveform audio player](./waveform-audio-player.md) — the audio playback control used in the dock and inline.
- [Plus tools menu (attachments)](../composer/plus-tools-menu.md) — how files and images get attached to a chat in the first place.
