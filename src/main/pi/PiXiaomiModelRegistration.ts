// Re-export shim. Implementation lives in host-shared so Electron main and the
// standalone pure-Node Host register the exact same unbundled MiMo rows.
export * from '../../host-shared/pi/PiXiaomiModelRegistration'
