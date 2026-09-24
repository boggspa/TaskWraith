// Electron compatibility entry. Keep this import first: store/index requires
// HostStoreRuntime at module evaluation and must never resolve Electron itself.
import './store/ElectronStoreRuntimeCompatibility'

export * from './store/index'
