'use strict'

const inspector = require('node:inspector')
const fs = require('node:fs')
const path = require('node:path')
const { captureProfileMarker, calibrateMainProfile } = require('./mainProfileCalibration.cjs')

/** Qualification only: markers run outside workload windows. Every attempt
 * retains the actual profile and source-marked evidence, including refusals. */
async function qualifyNativeMainProfile(options) {
  const directory = fs.mkdtempSync(path.join(options.outputRoot, 'native-calibration-'))
  const native = new inspector.Session()
  native.connect()
  const session = {
    post: (method, params) =>
      new Promise((resolve, reject) =>
        native.post(method, params ?? {}, (error, value) =>
          error ? reject(error) : resolve(value)
        )
      )
  }
  let profiling = false
  const markers = []
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: 250 })
    await session.post('Profiler.start')
    profiling = true
    markers.push(
      await captureProfileMarker(session, {
        windowId: 'native-qualification',
        durationMs: 40,
        timeoutMs: 1000
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    markers.push(
      await captureProfileMarker(session, {
        windowId: 'native-qualification',
        durationMs: 40,
        timeoutMs: 1000
      })
    )
    const { profile } = await session.post('Profiler.stop')
    profiling = false
    fs.writeFileSync(path.join(directory, 'main.cpuprofile'), JSON.stringify(profile))
    const calibration = calibrateMainProfile(profile, markers)
    const receipt = {
      runtime: process.version,
      samplingIntervalUs: 250,
      markerDurationMs: 40,
      excludedFromWorkload: true,
      directory,
      calibration
    }
    fs.writeFileSync(path.join(directory, 'qualification.json'), JSON.stringify(receipt, null, 2))
    return receipt
  } catch (error) {
    fs.writeFileSync(
      path.join(directory, 'failure.json'),
      JSON.stringify({ error: error.message, markers }, null, 2)
    )
    if (profiling) {
      const result = await session.post('Profiler.stop').catch(() => null)
      if (result?.profile)
        fs.writeFileSync(path.join(directory, 'main.cpuprofile'), JSON.stringify(result.profile))
    }
    throw error
  } finally {
    native.disconnect()
  }
}

module.exports = { qualifyNativeMainProfile }
