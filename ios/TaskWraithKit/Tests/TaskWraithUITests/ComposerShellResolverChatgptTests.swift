// Resolver-level parity test for the CS14 `chatgpt` composer shell — lives in the
// TaskWraithUI target because it exercises the SwiftUI recipe/layout layer (the
// pure style-model round-trip is covered in TaskWraithKitTests). See
// ios/COMPOSER-SHELL-PARITY.md (Part C ### chatgpt, Part E).
//
// FINAL SPEC: chatgpt = the cursor recipe with the inset rim removed (flat pill)
// over a PURE-cursor layout (no tuck). So it must resolve identical to cursor
// except `style` (.chatgpt) and `palette.rim` (nil).

import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Composer shell — chatgpt resolver (CS14)")
@MainActor
struct ComposerShellResolverChatgptTests {
    @Test("chatgpt resolves as a flat-pill cursor clone with a pure-cursor layout")
    func chatgptIsCursorMinusRim() {
        let ctx = ComposerShellContext(appIsLight: false)
        let chat = ComposerShellResolver.resolve(.chatgpt, context: ctx)
        let cursor = ComposerShellResolver.resolve(.cursor, context: ctx)

        // Identity + the ONE flat-pill delta vs cursor.
        #expect(chat.style == .chatgpt)
        #expect(chat.palette.rim == nil)      // flat pill: cursor's inset lip removed
        #expect(cursor.palette.rim != nil)    // cursor keeps its 1px rim lip

        // Layout is PURE cursor — no tuck (FINAL SPEC), field-for-field.
        #expect(ComposerShellResolver.composerLayout(for: .chatgpt)
            == ComposerShellResolver.composerLayout(for: .cursor))
        #expect(chat.layout == cursor.layout)
        #expect(chat.layout.tucksSecondaryRows == false)
        #expect(chat.layout.surfaceIsCapsule)   // cursor capsule body

        // Body inherits cursor VERBATIM apart from the rim: invariant fields match.
        #expect(chat.material == cursor.material)
        #expect(chat.geometry == cursor.geometry)         // incl. the shared 26px capsule radius
        #expect(chat.sendButton == cursor.sendButton)
        #expect(chat.themeImmune == cursor.themeImmune)    // theme-immune flat gray kept
        #expect(chat.palette.surfaceFill == cursor.palette.surfaceFill)
    }

    @Test("chatgpt is a known style that renders itself, not the default fallback")
    func chatgptIsKnownRendersSelf() {
        #expect(TWComposerStyle.chatgpt.isKnown)
        #expect(TWComposerStyle.chatgpt.renderStyle == .chatgpt)
        // Resolves in the light family too (recipe flips gray, style stays .chatgpt).
        let ctx = ComposerShellContext(appIsLight: true)
        #expect(ComposerShellResolver.resolve(.chatgpt, context: ctx).style == .chatgpt)
    }
}
