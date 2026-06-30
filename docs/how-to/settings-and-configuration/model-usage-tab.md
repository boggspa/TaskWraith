# How to: Model usage tab

**Platform:** Electron

## What it is
The Model usage tab is TaskWraith's cross-provider usage dashboard: headline token/run/provider tiles, a quota-meter card, a per-model usage-and-cost table, a model-comparison breakdown, provider quota/balance telemetry, API rate and context-length reference tables, and 90-day activity heatmaps and token charts.

## Where to find it
Open **Settings → Data → Model usage**.

<!-- TODO(screenshot): Model usage tab showing usage dashboard, API rates table, and context lengths table -->

## How to use it
1. Check the headline tiles at the top for total tokens, total runs, and how many providers/models have tracked activity.
2. Review the quota card for each signed-in provider's rolling usage windows and reset times.
3. Scroll to **Usage by provider & model** for a per-model breakdown across 1H / 24H / 7D / 30D / 90D, with token counts and estimated (not billed) cost; toggle **External Usage** to fold in provider activity tracked outside TaskWraith, and use the refresh button to force a re-fetch.
4. Check **Model Comparisons** to see which model accounted for the largest share of tokens over the last 30 days.
5. Look at **Provider Telemetry** for quota windows and balances (e.g. Grok credits) per provider, including how stale the snapshot is and when it was last fetched.
6. Reference **Provider/Model API Rates** for the USD-per-1M-token input/cached-input/output rates behind the cost estimates, and **Model Context Lengths** for each model's official maximum context window.
7. Scroll down to the 90-day activity heatmaps and token-usage charts to compare TaskWraith-tracked activity against external provider activity, filterable by provider.

## Tips & related
- [General tab](general-tab.md) — set your display currency and conservative cost overestimate percentage used here.
- [Providers tab](providers-tab.md) — sign in to providers so their usage and quota data populate this tab.
- [Welcome Screen](../getting-started/welcome-screen.md) — shows a lighter-weight usage dashboard and heatmaps for quick reference.
