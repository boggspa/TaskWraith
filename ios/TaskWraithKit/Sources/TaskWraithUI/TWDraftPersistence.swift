import Foundation

/// Process-lifetime store of typed-but-unsent composer drafts, keyed by thread id,
/// mirrored to `UserDefaults` so a draft survives thread-switch, the
/// `themes.revision` `.id()` teardown that destroys composer `@State`,
/// backgrounding, AND an app relaunch.
///
/// Deliberately NOT an `@Published` field on `RemoteSessionModel`: the composer
/// rewrites `text` on every keystroke, and routing that through an
/// `ObservableObject` would invalidate every view observing the model
/// (`ObservableObject` is coarse-grained — one `objectWillChange` re-renders them
/// all). The composer instead keeps its fast local `@State` and calls these
/// imperatively — `.onAppear` to restore, `.onChange(of:)` to record. In-memory
/// writes are immediate (so thread-switch is instant); the disk write is debounced.
@MainActor
enum TWDraftPersistence {
    private static let defaultsKey = "tw.composer.drafts.v1"
    private static let debounce: Duration = .seconds(0.8)
    /// Skip persisting an absurd paste — keep it live in the editor, just don't
    /// write a multi-hundred-KB blob to UserDefaults (mirrors the Electron cap).
    private static let maxPersistedChars = 100_000

    private static var cache: [String: String] = load()
    private static var saveTask: Task<Void, Never>?

    /// Restore a thread's draft ("" if none). Call from `.onAppear`.
    static func draft(for id: String) -> String {
        id.isEmpty ? "" : (cache[id] ?? "")
    }

    /// Record a thread's draft. Call from `.onChange(of: text)`. Empty/whitespace
    /// PRUNES the entry, so a sent or cleared prompt can't resurrect next launch.
    static func setDraft(_ text: String, for id: String) {
        guard !id.isEmpty else { return }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard cache.removeValue(forKey: id) != nil else { return }
        } else if cache[id] == text {
            return
        } else {
            cache[id] = text
        }
        scheduleSave()
    }

    /// Force a synchronous flush — call when the scene leaves `.active` so the last
    /// keystrokes before suspension/termination are durable even inside the debounce.
    static func flush() {
        saveTask?.cancel()
        saveTask = nil
        save()
    }

    private static func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            save()
        }
    }

    private static func save() {
        var toStore: [String: String] = [:]
        for (id, text) in cache
        where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            toStore[id] =
                text.count > maxPersistedChars ? String(text.prefix(maxPersistedChars)) : text
        }
        if let data = try? JSONEncoder().encode(toStore) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }

    private static func load() -> [String: String] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
            let decoded = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        return decoded
    }
}
