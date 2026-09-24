/**
 * Process-wide optional handle onto the main WorkSpanRecorder.
 *
 * The persist client is constructed lazily from the store module, which cannot
 * close over `mainWorkSpanRecorder` in index.ts. Bind once after the recorder
 * is created; readers after that see the production sink. Absence is safe.
 */

import type { WorkSpanRecordInput } from './WorkSpanRecorder'

export type MainWorkSpanSink = {
  record(span: WorkSpanRecordInput): void
}

let sink: MainWorkSpanSink | undefined

export function bindMainWorkSpanSink(next: MainWorkSpanSink | undefined): void {
  sink = next
}

export function mainWorkSpanSink(): MainWorkSpanSink | undefined {
  return sink
}
