// Shared source of truth for the branded DMG artwork generator and its tests.
// electron-builder.yml mirrors the Finder-facing values because its YAML
// configuration cannot import this module.

module.exports = Object.freeze({
  artwork: Object.freeze({ width: 660, height: 420 }),
  background: Object.freeze({ width: 960, height: 720 }),
  window: Object.freeze({ width: 660, height: 544 }),
  icons: Object.freeze({
    appX: 172,
    applicationsX: 488,
    y: 250,
    size: 100,
    textSize: 13
  })
})
