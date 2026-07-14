import XCTest

/// App Store screenshot harness — drives the OFFLINE demo session (canned
/// data, no pairing, no network; the same surface App Review exercises via
/// the `-tw-demo` launch argument) through the marketing screens and attaches
/// full-screen captures with `.keepAlways` lifetime.
///
/// Run via `scripts/appstore-screenshots.sh`, which executes this suite on
/// the App Store device classes (6.9" iPhone + 13" iPad) and exports the
/// attachments from the result bundle into `screenshots/<device>/`.
final class TaskWraithScreenshotUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureAppStoreScreenshots() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-tw-demo"]
        app.launch()

        // Home — the demo projection's task cards are the proof the demo
        // booted (the pairing screen contains none of these titles).
        let authCard = app.staticTexts["Refactor the auth module"].firstMatch
        XCTAssertTrue(authCard.waitForExistence(timeout: 15))
        settle()
        snap(app, "01-home")

        // Single-agent thread detail — transcript + composer shell.
        authCard.tap()
        awaitComposer(app)
        settle()
        snap(app, "02-thread-detail")

        // Ensemble thread detail — the multi-agent surface.
        goBack(app)
        let ensembleCard = app.staticTexts["Plan the v2 public API"].firstMatch
        XCTAssertTrue(ensembleCard.waitForExistence(timeout: 15))
        ensembleCard.tap()
        awaitComposer(app)
        settle()
        snap(app, "03-ensemble")
    }

    /// The composer's text input is the one element every thread-detail
    /// variant renders; its arrival marks the detail transition as done.
    private func awaitComposer(_ app: XCUIApplication) {
        let composer = app.textViews.firstMatch
        if !composer.waitForExistence(timeout: 10) {
            _ = app.textFields.firstMatch.waitForExistence(timeout: 5)
        }
    }

    /// Nav-bar back when present (system chevron), edge swipe as fallback —
    /// covers both the iPhone stack push and custom-chrome variants.
    private func goBack(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons.firstMatch
        if back.exists, back.isHittable {
            back.tap()
            return
        }
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    /// Let reveal/scroll animations finish so captures are stable frames.
    private func settle() {
        Thread.sleep(forTimeInterval: 1.2)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
