import { ipcMain } from 'electron'
import { normalizeMistralPlanId } from '../mistral/MistralCliArgs'
import { mistralAdminKeyStore } from '../mistral/MistralAdminKeyStore'
import {
  convertVendorAmountToUsd,
  fetchMistralAdminUsage,
  meterSpendFrom
} from '../mistral/MistralAdminUsage'
import {
  clearMistralQuotaAnchor,
  currentMistralQuotaEstimate,
  setMistralPlan,
  setMistralQuotaAnchor,
  setMistralQuotaReport,
  type MistralQuotaSnapshot
} from '../mistral/MistralQuotaStore'

export const MISTRAL_QUOTA_GET_CHANNEL = 'mistral-quota:get'
export const MISTRAL_QUOTA_SET_PLAN_CHANNEL = 'mistral-quota:set-plan'
export const MISTRAL_QUOTA_SET_ANCHOR_CHANNEL = 'mistral-quota:set-anchor'
export const MISTRAL_QUOTA_CLEAR_ANCHOR_CHANNEL = 'mistral-quota:clear-anchor'
export const MISTRAL_ADMIN_KEY_STATUS_CHANNEL = 'mistral-admin-key:status'
export const MISTRAL_ADMIN_KEY_SET_CHANNEL = 'mistral-admin-key:set'
export const MISTRAL_ADMIN_KEY_CLEAR_CHANNEL = 'mistral-admin-key:clear'
export const MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL = 'mistral-quota:refresh-admin'

export interface MistralQuotaHandlerDeps {
  /**
   * Bootstrap-local web-usage lane refresh. Injected because the lane is
   * created in index.ts bootstrap scope; every other collaborator is a
   * hoisted module import available at registration time.
   */
  requestWebUsageRefresh: () => void
}

export function registerMistralQuotaHandlers(deps: MistralQuotaHandlerDeps): void {
  // Mistral's ESTIMATED monthly burn. Deliberately NOT a probe and not a
  // vendor figure — Mistral publishes no quota for any plan and has no usage
  // endpoint, so this reads the locally accumulated cycle. Resolves null until
  // the seat has actually run, which is what gates the sidebar meter.
  ipcMain.handle(MISTRAL_QUOTA_GET_CHANNEL, async (): Promise<MistralQuotaSnapshot | null> => {
    // Opportunistic web-session refresh: fire-and-forget with its own TTL,
    // so the renderer's ordinary 30s poll keeps an imported console reading
    // fresh without a main-side timer. This read returns the CURRENT
    // estimate; an absorbed refresh shows up on the next poll.
    deps.requestWebUsageRefresh()
    return currentMistralQuotaEstimate()
  })

  // Which plan the user believes they are on. Undetectable from the lane —
  // nothing Vibe sends reports it — so it has to be declared. Until this
  // existed the store's `setPlan` had no caller at all and every seat metered
  // as `unknown`, which now seeds LOW (as Free): a Pro seat left undeclared is
  // banded against a third of its real allowance.
  ipcMain.handle(
    MISTRAL_QUOTA_SET_PLAN_CHANNEL,
    async (_, plan: string): Promise<MistralQuotaSnapshot | null> => {
      await setMistralPlan(normalizeMistralPlanId(plan))
      return currentMistralQuotaEstimate()
    }
  )

  // A reading taken off admin.mistral.ai/subscription. Amounts arrive in USD,
  // already converted by the renderer.
  ipcMain.handle(
    MISTRAL_QUOTA_SET_ANCHOR_CHANNEL,
    async (_, reading: Record<string, unknown>): Promise<MistralQuotaSnapshot | null> => {
      const allowanceUsd = Number(reading?.allowanceUsd)
      const spentUsd = Number(reading?.spentUsd)
      // A non-positive allowance would divide the whole meter by zero, and a
      // negative spend is meaningless. Reject rather than clamp: a silently
      // corrected reading is worse than a rejected one the user can retype.
      if (!Number.isFinite(allowanceUsd) || allowanceUsd <= 0) return currentMistralQuotaEstimate()
      if (!Number.isFinite(spentUsd) || spentUsd < 0) return currentMistralQuotaEstimate()
      const declared = reading?.declared as
        | { allowance?: unknown; spent?: unknown; currency?: unknown }
        | undefined
      await setMistralQuotaAnchor({
        allowanceUsd,
        spentUsd,
        ...(typeof reading?.cycleResetsAt === 'string' &&
        !Number.isNaN(new Date(reading.cycleResetsAt).getTime())
          ? { cycleResetsAt: new Date(reading.cycleResetsAt).toISOString() }
          : {}),
        ...(declared &&
        Number.isFinite(Number(declared.allowance)) &&
        Number.isFinite(Number(declared.spent)) &&
        typeof declared.currency === 'string' &&
        declared.currency.trim()
          ? {
              declared: {
                allowance: Number(declared.allowance),
                spent: Number(declared.spent),
                currency: declared.currency.trim().toUpperCase()
              }
            }
          : {})
      })
      return currentMistralQuotaEstimate()
    }
  )

  ipcMain.handle(
    MISTRAL_QUOTA_CLEAR_ANCHOR_CHANNEL,
    async (): Promise<MistralQuotaSnapshot | null> => {
      await clearMistralQuotaAnchor()
      return currentMistralQuotaEstimate()
    }
  )

  ipcMain.handle(MISTRAL_ADMIN_KEY_STATUS_CHANNEL, async () => {
    return mistralAdminKeyStore()?.getStatus() ?? null
  })

  ipcMain.handle(MISTRAL_ADMIN_KEY_SET_CHANNEL, async (_, apiKey: string) => {
    const store = mistralAdminKeyStore()
    if (!store) return { ok: false, error: 'unavailable' }
    const result = store.setApiKey(String(apiKey ?? ''))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })

  ipcMain.handle(MISTRAL_ADMIN_KEY_CLEAR_CHANNEL, async () => {
    const store = mistralAdminKeyStore()
    if (!store) return { ok: false, error: 'unavailable' }
    const result = store.clear()
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })

  // Pull this month's figures from the Admin API and fold them into the meter.
  // Enterprise-only by construction — every other plan gets `no-key` or
  // `unauthorized` and keeps whatever source it already had. Nothing here can
  // throw: the client returns typed outcomes precisely so a meter refresh
  // cannot take anything else down with it.
  ipcMain.handle(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL, async () => {
    const keyStore = mistralAdminKeyStore()
    if (!keyStore) return { ok: false, failure: 'unavailable' }
    const loaded = keyStore.loadApiKey()
    if (loaded.status !== 'ok') {
      return { ok: false, failure: loaded.status === 'missing' ? 'no-key' : loaded.status }
    }
    const outcome = await fetchMistralAdminUsage({ apiKey: loaded.value })
    if (!outcome.ok) return { ok: false, failure: outcome.failure }

    const declaredCurrency = outcome.usage.currency
    const spentDeclared = meterSpendFrom(outcome.usage)
    await setMistralQuotaReport({
      // The vendor reports in its own currency; the model is USD. Convert
      // here in main using a static table — the live rates live in the
      // renderer, and reaching for them would add a main→renderer edge.
      spentUsd: convertVendorAmountToUsd(spentDeclared, declaredCurrency),
      fetchedAt: new Date().toISOString(),
      ...(outcome.usage.periodStart ? { periodStart: outcome.usage.periodStart } : {}),
      ...(outcome.usage.periodEnd ? { periodEnd: outcome.usage.periodEnd } : {}),
      ...(declaredCurrency
        ? { declared: { spent: spentDeclared, currency: declaredCurrency } }
        : {})
    })
    return { ok: true, snapshot: await currentMistralQuotaEstimate() }
  })
}

export function unregisterMistralQuotaHandlers(): void {
  ipcMain.removeHandler(MISTRAL_QUOTA_GET_CHANNEL)
  ipcMain.removeHandler(MISTRAL_QUOTA_SET_PLAN_CHANNEL)
  ipcMain.removeHandler(MISTRAL_QUOTA_SET_ANCHOR_CHANNEL)
  ipcMain.removeHandler(MISTRAL_QUOTA_CLEAR_ANCHOR_CHANNEL)
  ipcMain.removeHandler(MISTRAL_ADMIN_KEY_STATUS_CHANNEL)
  ipcMain.removeHandler(MISTRAL_ADMIN_KEY_SET_CHANNEL)
  ipcMain.removeHandler(MISTRAL_ADMIN_KEY_CLEAR_CHANNEL)
  ipcMain.removeHandler(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL)
}
