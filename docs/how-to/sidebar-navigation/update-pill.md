# How to: Update Pill

**Platform:** Electron

## What it is
A small button above the sidebar masthead that appears only when there is an update to act on. Its label tells you the state: **Update 1.9.9** when one is available, a percentage while it downloads, **Restart** when it is ready to install, **Restart queued** when TaskWraith is waiting for your agents to finish, or **Update issue** if something went wrong.

## Where to find it
At the very top of the sidebar, just above the TaskWraith masthead. It is hidden when no update needs your attention.

<!-- screenshot-pending: Sidebar update pill above the masthead -->

## How to use it
1. Click the pill. On **Update**, that starts the download; on **Restart**, it installs and relaunches after you confirm.
2. To read the release notes first, open the update sheet from the **?** corner button and click **Open release** or **Download update**.
3. When the download finishes, click **Restart to install**. TaskWraith waits if agent runs, scheduled tasks, or workflows are still going, and the sheet says what it is waiting for — for example "Waiting for 1 active agent run".
4. To install without waiting, click **Restart anyway** in the update sheet and confirm. Running turns, scheduled tasks, and Host runs are interrupted.

## Tips & related
- A queued restart waits at most 30 minutes. After that it stops waiting and the sheet asks you to restart when you are ready — the download is kept either way.
- Hover the pill for the full explanation, including the reason a restart is queued.
- [General tab](../settings-and-configuration/general-tab.md) — update-related behavior toggles.
