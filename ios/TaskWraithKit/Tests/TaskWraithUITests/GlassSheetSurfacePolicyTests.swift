import Testing

@testable import TaskWraithUI

@Suite("Glass sheet surface policy")
struct GlassSheetSurfacePolicyTests {
    @Test func nonGlassHostsKeepTheirDefaultFills() {
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: false, glassEnabled: true) == nil)
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: false, glassEnabled: false) == nil)
    }

    @Test func glassHostedSurfacesWashTranslucent() {
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: true, glassEnabled: true) == 0.35)
    }

    /// Light-family themes (Light/Alabaster/Mist) need a much heavier wash:
    /// `surface1` is near-white there, so the dark-tuned 0.35 alpha leaves rows
    /// indistinguishable from the equally pale glass backdrop — the sheet read
    /// as flat gray with no row/card separation. Dark themes are unaffected.
    @Test func lightThemesGetAHeavierWashThanDarkThemes() {
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: true, glassEnabled: true, isLight: true) == 0.72)
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: true, glassEnabled: true, isLight: false) == 0.35)
    }

    @Test func reduceTransparencyKeepsGlassHostedSurfacesOpaqueRegardlessOfTheme() {
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: true, glassEnabled: false) == 1.0)
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: true, glassEnabled: false, isLight: true) == 1.0)
    }

    /// Diff Studio's chrome tier delegates here — the two policies must never
    /// drift apart, or sheets wash their surfaces inconsistently.
    @Test func diffStudioChromeTierDelegatesToTheSharedPolicy() {
        for hosted in [true, false] {
            for enabled in [true, false] {
                for isLight in [true, false] {
                    #expect(
                        DiffStudioSheetGlassPolicy.chromeFillAlpha(
                            glassSheetHosted: hosted, glassEnabled: enabled, isLight: isLight)
                            == TWGlassSheetSurfacePolicy.chromeFillAlpha(
                                glassSheetHosted: hosted, glassEnabled: enabled, isLight: isLight))
                }
            }
        }
    }
}
