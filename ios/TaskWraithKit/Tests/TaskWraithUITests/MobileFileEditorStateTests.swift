import Testing

@testable import TaskWraithUI

@Suite("Mobile File Editor state")
struct MobileFileEditorStateTests {
    @MainActor
    @Test func languageLabelMatchesDesktopStatusBarFamilies() {
        #expect(MobileFileEditorState.languageLabel(for: "src/App.swift") == "Swift")
        #expect(MobileFileEditorState.languageLabel(for: "src/renderer/App.tsx") == "TSX")
        #expect(MobileFileEditorState.languageLabel(for: "src/lib/model.ts") == "TypeScript")
        #expect(MobileFileEditorState.languageLabel(for: "scripts/build.mjs") == "JavaScript")
        #expect(MobileFileEditorState.languageLabel(for: "README.md") == "Markdown")
        #expect(MobileFileEditorState.languageLabel(for: "package.json") == "JSON")
        #expect(MobileFileEditorState.languageLabel(for: "theme.scss") == "CSS")
        #expect(MobileFileEditorState.languageLabel(for: "src/native/Bridge.mm") == "C/C++")
        #expect(MobileFileEditorState.languageLabel(for: ".env") == "Shell")
        #expect(MobileFileEditorState.languageLabel(for: "profile") == "Shell")
        #expect(MobileFileEditorState.languageLabel(for: "home/.config/zshrc") == "Shell")
        #expect(MobileFileEditorState.languageLabel(for: "LICENSE") == "Plain Text")
    }
}
