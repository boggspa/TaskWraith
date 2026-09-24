// Re-export shim. Implementation lives in host-shared so Electron main and the
// standalone pure-Node Host register the exact same curated OpenRouter models.
export * from '../../host-shared/pi/PiOpenRouterModelRegistration'
