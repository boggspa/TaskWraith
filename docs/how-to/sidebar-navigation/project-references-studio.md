# How to: Project References Studio

**Platform:** Electron

## What it is
A drafting tool inside a Project's reference shelf. Pick the references you care about and Studio writes a first draft from them — a **Briefing**, an **FAQ**, or a **Decision log**. The draft is a starting point built from your own sources, not a finished document.

<!-- screenshot-pending: Project library dock showing the Studio row and a generated draft with Save to library and Discard -->

## Where to find it
Select **Work**, choose a Project, then open the **Refs** tab in the right dock. Under the **Project library** header, the **Studio** row sits above the reference list.

## How to use it
1. Click **Use next** on the references you want the draft built from. Studio stays disabled until at least one is selected.
2. Click **Briefing**, **FAQ**, or **Decision log**.
3. Wait for **Studio draft ready** to appear, showing the kind and title.
4. Click **Save to library** to keep it, or **Discard** to throw it away.

## Tips & related
- A saved draft joins the Project's reference list with a badge — **Briefing**, **FAQ**, or **Decisions** — so you can feed it into a later draft like any other source.
- Drafts are deliberately skeletal: headings, your source excerpts, and placeholders to fill in. Edit before you rely on one.
- Studio only reads references you have already selected, so nothing is pulled in that you did not choose.
- Saved files live in your workspace under `.taskwraith/project-library/`, so they travel with the project rather than living only in the app.
- [Project Reference Library](project-reference-library.md) — adding, verifying, and selecting the references Studio draws from.
- [Sidebar sections](sidebar-sections.md) — the Chat, Code, and Work surfaces.
