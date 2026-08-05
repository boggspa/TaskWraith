import SwiftUI

/// The five thread-level permission presets, once.
///
/// Desktop colour-coding (`08-theme-picker-overrides.css`, shell-agnostic
/// block): Plan / Ask → blue, Accept Edits → neutral, Full WS Access → amber,
/// Full Access → dark red. The selected checkmark, the closed trigger, and the
/// ensemble seat strip all adopt the same tier tint so the colour identity
/// reads across every state.
///
/// This lives on its own because the table had started to multiply: the roster
/// sidecar picker owned one copy and the composer had re-spelled the labels in
/// a switch. A preset renamed in one place and not the other is a silent
/// cross-surface lie about what a seat is allowed to do, which is exactly the
/// kind of drift `ids unchanged, labels only` renames produce.
///
/// The `id`s are the literal desktop preset ids and are WIRE values — never
/// rename them, only the labels.
struct TWPermissionTier: Identifiable, Equatable {
    let id: String
    /// Space-starved form for a trigger (roster sidecar chip).
    let short: String
    /// Full form for a menu row, the composer's label, and the seat strip.
    let label: String
    let systemImage: String
    /// nil = neutral (Accept Edits keeps the untinted palette).
    var tint: Color?

    init(id: String, short: String, label: String, systemImage: String, tint: Color? = nil) {
        self.id = id
        self.short = short
        self.label = label
        self.systemImage = systemImage
        self.tint = tint
    }
}

enum TWPermissionTiers {
    static let blue = Color(hex: 0x6FB6FF)
    static let amber = Color(hex: 0xF59E0B)
    static let red = Color(hex: 0xDC2626)

    /// Ordered least- to most-capable — the order every picker presents.
    static let all: [TWPermissionTier] = [
        TWPermissionTier(
            id: "plan", short: "Plan", label: "Plan",
            systemImage: "list.clipboard", tint: blue),
        TWPermissionTier(
            id: "read_only", short: "Ask", label: "Ask",
            systemImage: "lock.shield", tint: blue),
        TWPermissionTier(
            id: "default", short: "Accept", label: "Accept Edits",
            systemImage: "checkmark.shield"),
        TWPermissionTier(
            id: "workspace_write", short: "Full WS", label: "Full WS Access",
            systemImage: "pencil.and.outline", tint: amber),
        TWPermissionTier(
            id: "full_access", short: "Full", label: "Full Access",
            systemImage: "bolt.shield", tint: red),
    ]

    /// nil / unknown resolve to Accept Edits, the desktop default — an id a
    /// newer Mac invents degrades to the neutral tier rather than to nothing.
    static func tier(_ presetId: String?) -> TWPermissionTier {
        let id = (presetId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // Fall back BY ID, not by position: `all[2]` is the neutral tier today,
        // and silently stops being it the moment anyone reorders the table.
        return all.first { $0.id == id } ?? all.first { $0.id == "default" } ?? all[0]
    }

    /// Full label for a preset id. The one spelling of these five words.
    static func label(_ presetId: String?) -> String { tier(presetId).label }
}
