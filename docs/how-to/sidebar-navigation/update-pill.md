# How to: Update Pill

**Platform:** Electron

## What it is
A one-click update pill that appears above the sidebar masthead whenever there's an update to act on — a new version available, a download in progress, a downloaded update ready to install, or an update error.

## Where to find it
In the **Sidebar**, directly above the masthead (workspace name / + button area), for as long as an update is available, downloading, downloaded, or has hit an error.

<!-- TODO(screenshot): Sidebar update pill above the masthead -->

## How to use it
1. Look for the pill above the masthead. Its label reflects the current state: "Update" to start, a download percentage while downloading, "Restart" once downloaded, or "Update issue" on error.
2. Click it: this starts the download when an update is available, or restarts TaskWraith to finish installing once the update has downloaded.

## Tips & related
- The update process is automatic — no manual download required.
- Check [General tab](../settings-and-configuration/general-tab.md) for update-related behavior toggles.
