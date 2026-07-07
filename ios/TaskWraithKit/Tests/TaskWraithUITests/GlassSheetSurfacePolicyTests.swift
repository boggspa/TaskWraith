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

    @Test func reduceTransparencyKeepsGlassHostedSurfacesOpaque() {
        #expect(
            TWGlassSheetSurfacePolicy.chromeFillAlpha(
                glassSheetHosted: true, glassEnabled: false) == 1.0)
    }

    /// Diff Studio's chrome tier delegates here — the two policies must never
    /// drift apart, or sheets wash their surfaces inconsistently.
    @Test func diffStudioChromeTierDelegatesToTheSharedPolicy() {
        for hosted in [true, false] {
            for enabled in [true, false] {
                #expect(
                    DiffStudioSheetGlassPolicy.chromeFillAlpha(
                        glassSheetHosted: hosted, glassEnabled: enabled)
                        == TWGlassSheetSurfacePolicy.chromeFillAlpha(
                            glassSheetHosted: hosted, glassEnabled: enabled))
            }
        }
    }
}
