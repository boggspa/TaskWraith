// Canvas-preview decode — the wire contract behind the iOS read-only Canvas card.
//
// The Mac projects this chat's OPEN Canvas sessions as a structured
// `taskCard.canvasPreviews = [{canvasId, driver, url, title, status, viewport}]`
// field (src/main/RemoteTaskProjection.ts buildRemoteCanvasPreviews). This pins
// the Swift decode: field names match the Mac 1:1, an absent field decodes to nil
// (older Mac builds stay compatible — additive optional + synthesized Codable),
// and an unexpected `status`/`driver` string degrades to a plain String.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Canvas-preview decode")
struct CanvasPreviewDecodeTests {
    private func card(_ json: String) throws -> RemoteTaskCard {
        try JSONDecoder().decode(RemoteTaskCard.self, from: Data(json.utf8))
    }

    @Test("an active web canvas decodes id/driver/url/title/status/viewport 1:1")
    func activeCanvas() throws {
        let c = try card(
            """
            {"id":"chat1","canvasPreviews":[
              {"canvasId":"cv1","driver":"web","url":"http://localhost:3000/",
               "title":"Dashboard","status":"active","viewport":{"width":1280,"height":800}}]}
            """)
        let p = c.canvasPreviews?.first
        #expect(p?.canvasId == "cv1")
        #expect(p?.driver == "web")
        #expect(p?.url == "http://localhost:3000/")
        #expect(p?.title == "Dashboard")
        #expect(p?.status == "active")
        #expect(p?.viewport?.width == 1280)
        #expect(p?.viewport?.height == 800)
        #expect(p?.isActive == true)
        #expect(p?.displayLabel == "Dashboard")
    }

    @Test("displayLabel falls back to the url host when the title is empty")
    func displayLabelFallback() throws {
        let c = try card(
            """
            {"id":"chat1","canvasPreviews":[
              {"canvasId":"cv1","driver":"device","url":"http://10.0.0.5:8080/x","title":"",
               "status":"opening","viewport":{"width":375,"height":812}}]}
            """)
        #expect(c.canvasPreviews?.first?.displayLabel == "10.0.0.5")
    }

    @Test("a card from an older Mac (no canvasPreviews field) decodes with nil")
    func olderMacNoField() throws {
        let c = try card(#"{"id":"chat1","title":"Build the thing"}"#)
        #expect(c.canvasPreviews == nil)
    }

    @Test("an unexpected status/driver decodes as a plain String; absent viewport is nil")
    func unknownValuesDegrade() throws {
        let c = try card(
            """
            {"id":"chat1","canvasPreviews":[
              {"canvasId":"cv1","driver":"hologram","url":"http://x/","title":"T","status":"frozen"}]}
            """)
        let p = c.canvasPreviews?.first
        #expect(p?.status == "frozen")
        #expect(p?.driver == "hologram")
        #expect(p?.isActive == false)
        #expect(p?.viewport == nil)
    }
}
