/*
 * Build-time defines, read through a `typeof … !== 'undefined'` guard.
 *
 * ALWAYS go through this module — never reference a `__DEFINE__` symbol
 * directly in a component. A bare reference to a symbol Vite did not substitute
 * is a ReferenceError thrown DURING RENDER, which unmounts the whole surface
 * rather than degrading the one feature. That happens whenever the define and
 * the running bundle disagree: a dev server started before the define was added
 * (HMR does not pick up config-level `define`), a packaging path that misses
 * it, or a test/Storybook harness that never sets it.
 *
 * Each flag picks the fallback that is SAFE when the value is unknown, not the
 * one that is convenient.
 */

/** Fallback true: the iOS remote surface is the shipped default, and hiding it
 * on an unknown define would silently remove pairing from the app. */
export const IOS_REMOTE_ENABLED =
  typeof __IOS_REMOTE_TRUE__ !== 'undefined' ? __IOS_REMOTE_TRUE__ : true

/** Fallback FALSE: this gates whether a reporting endpoint is configured at
 * all. Unknown must read as "not configured" so the UI never tells the user
 * reporting is available when the build cannot send anything. Fail closed —
 * this one is a privacy surface. */
export const ACTIVITY_REPORTING_CONFIGURED =
  typeof __TASKWRAITH_ACTIVITY_REPORTING_CONFIGURED__ !== 'undefined'
    ? __TASKWRAITH_ACTIVITY_REPORTING_CONFIGURED__
    : false
