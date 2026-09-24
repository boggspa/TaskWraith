# How to: Routines and scheduled tasks

**Platform:** Electron

## What it is
Run agent prompts on a schedule. Two options exist: a **one-shot** schedule for a single message, and a recurring **Workflow** (manual or interval) that re-runs a saved prompt template. Both use the same scheduled-task queue.

## Where to find it
For a single message: **clock icon** in the composer's control row. For recurring runs: select **Code**, then use the **Workflows** section in the sidebar and its **+** button.

![ComposerScheduleButton showing quick-offset schedule picker](../images/goals-todos-and-scheduling__routines-and-scheduled-tasks.png)

## How to use it
1. For a single prompt, click the **clock icon** in the composer, pick a date/time (or preset like **15m**, **1h**, **Tonight**, **Tomorrow**), then click **Schedule** and send — it runs automatically at that time.
2. For a recurring routine, select **Code**, click **+** next to **Workflows** in the sidebar. This opens a new chat in workflow-compose mode (requires a workspace).
3. Choose **Cadence** — **Manual** (runs when triggered) or **Every** with an interval in minutes.
4. Set **Max runs per day** and choose **Unattended permissions** for when you are not watching.
5. Type the prompt and send — this first send saves the settings as the workflow definition.
6. Manage existing workflows from the Code surface's **Workflows** section: expand to **Run now**, **Pause/Resume**, set/change **interval**, grant/revoke **unattended permissions**, **Cancel** a run, or **Delete**.

## Tips & related
- [Schedule Prompt](../composer/schedule-prompt.md) — one-shot composer schedule control
- [Workflow Creator](../workflows-and-boards/workflow-creator.md) — create a recurring workflow
- [Workflow Compose Controls](../workflows-and-boards/workflow-compose-controls.md) — cadence and interval options
- [Workflows Sidebar Section](../workflows-and-boards/workflows-sidebar-section.md) — manage workflows after creation
