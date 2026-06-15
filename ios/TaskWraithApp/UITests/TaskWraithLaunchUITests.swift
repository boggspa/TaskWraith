import XCTest

final class TaskWraithLaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testColdLaunchShowsAppShell() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        XCTAssertTrue(app.windows.element(boundBy: 0).waitForExistence(timeout: 8))
    }
}
