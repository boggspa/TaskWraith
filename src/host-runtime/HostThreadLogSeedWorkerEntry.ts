/**
 * The seed worker: loads threads from their logs off the Host loop. The Host
 * build compiles it beside `HostThreadLogWorkerSeed`, which starts it.
 */
import { parentPort } from 'node:worker_threads'

import { serveHostThreadLogLoads } from './HostThreadLogLoad'

if (!parentPort) throw new Error('The thread log seed worker needs a parent to answer')
serveHostThreadLogLoads(parentPort)
