// Pure presentation model for tool-row file + URL target detection.
//
// Desktop parity sources:
//   - `urlPresentation.ts` (normalize / extract / merge HTTP links)
//   - `CompactToolTrace.lib.ts` (`extractToolFilePath`, `extractToolUrlTargets`)
//   - `TranscriptFileTarget.tsx` (Open / Reveal / Copy actions)
//   - `ActivityPathDisplay.ts` (workspace-absolute resolve + display labels)
//
// iOS ToolEntry already projects a first-class `file` plus free-text `detail`.
// This model also accepts an optional parameter bag + result text so a future
// richer projection (or local tool-trace foldout) can feed the same surface
// without growing Models.swift / ThreadDetailViews here.
//
// No bridge, open, or reveal host calls — integrators supply callbacks only.

import Foundation

// MARK: - Targets

/// Normalized HTTP(S) presentation target. Credentials and fragment are
/// stripped; `host` drops a leading `www.` for compact badges.
public struct ToolUrlPresentationTarget: Equatable, Sendable, Identifiable, Hashable {
    public let url: String
    public let origin: String
    public let host: String

    public var id: String { url }

    public init(url: String, origin: String, host: String) {
        self.url = url
        self.origin = origin
        self.host = host
    }
}

/// File path the tool acted on, with display + absolute forms for chrome.
public struct ToolFilePresentationTarget: Equatable, Sendable, Identifiable, Hashable {
    /// Path exactly as the tool / projection reported it.
    public let rawPath: String
    /// Compact inline label (typically last 1–2 path segments).
    public let displayLabel: String
    /// Best-effort absolute path for tooltips / Copy / Open callbacks.
    /// May still be relative when no workspace root is available.
    public let absolutePath: String
    /// Workspace-relative or tildified form for secondary labels.
    public let displayPath: String

    public var id: String { rawPath }

    public init(
        rawPath: String,
        displayLabel: String,
        absolutePath: String,
        displayPath: String
    ) {
        self.rawPath = rawPath
        self.displayLabel = displayLabel
        self.absolutePath = absolutePath
        self.displayPath = displayPath
    }
}

/// Closed set of actions the inspect chrome may offer. Host wiring is out of
/// scope — the surface only fires optional callbacks.
public enum ToolTargetInspectAction: String, Equatable, Sendable, CaseIterable {
    case open
    case reveal
    case copyPath
    case inspect
}

/// Honest component input — no wire decode. Parameter values are already
/// stringified by the caller so this file stays free of Models.swift.
public struct ToolTargetDetectionInput: Equatable, Sendable {
    /// First-class projected file path (desktop `activity.filePath` / ToolEntry.file).
    public var file: String?
    /// Free-text detail / preview that may embed paths or URLs.
    public var detail: String?
    /// Optional parameter bag (desktop `activity.parameters` string values).
    public var parameterStrings: [String: String]
    /// Optional result / output preview text for URL mining.
    public var resultText: String?
    /// Workspace root used to resolve relative file paths.
    public var workspacePath: String?
    /// Cap on extracted URL targets (desktop tool default is 5).
    public var urlLimit: Int

    public init(
        file: String? = nil,
        detail: String? = nil,
        parameterStrings: [String: String] = [:],
        resultText: String? = nil,
        workspacePath: String? = nil,
        urlLimit: Int = 5
    ) {
        self.file = file
        self.detail = detail
        self.parameterStrings = parameterStrings
        self.resultText = resultText
        self.workspacePath = workspacePath
        self.urlLimit = max(0, urlLimit)
    }
}

/// Derived presentation for one tool row’s file + URL targets.
public struct ToolTargetPresentationModel: Equatable, Sendable {
    public var fileTarget: ToolFilePresentationTarget?
    public var urlTargets: [ToolUrlPresentationTarget]
    /// True when any clickable / inspectable target is present.
    public var hasTargets: Bool { fileTarget != nil || !urlTargets.isEmpty }
    /// Compact sources section should appear when there is at least one URL.
    public var showsSourcesSection: Bool { !urlTargets.isEmpty }
    /// Primary URL badge for the collapsed row (desktop shows `urlTargets[0]`).
    public var primaryUrlTarget: ToolUrlPresentationTarget? { urlTargets.first }

    public init(
        fileTarget: ToolFilePresentationTarget? = nil,
        urlTargets: [ToolUrlPresentationTarget] = []
    ) {
        self.fileTarget = fileTarget
        self.urlTargets = urlTargets
    }
}

// MARK: - Model API

public enum ToolFileUrlTargetModel {
    /// Ordered param keys treated as "the file this tool acted on" — mirrors
    /// desktop `TOOL_FILE_PATH_KEYS` / `getPathFromRecord`.
    public static let filePathParameterKeys: [String] = [
        "file_path",
        "filePath",
        "path",
        "target",
        "target_file",
        "target_file_path",
        "source",
        "source_file",
        "source_file_path",
        "destination",
        "destination_file",
        "destination_file_path",
    ]

    public static let defaultUrlLimit = 5
    public static let textUrlExtractLimit = 6
    /// Hard bound on raw path length accepted for presentation (reject noise).
    public static let maxPathLength = 2_048
    /// Hard bound on a single extracted URL string before normalization.
    public static let maxUrlLength = 2_048

    // MARK: Build

    public static func makePresentation(
        from input: ToolTargetDetectionInput
    ) -> ToolTargetPresentationModel {
        let filePath = extractToolFilePath(
            parameterStrings: input.parameterStrings,
            filePath: input.file
        )
        let fileTarget = filePath.flatMap {
            makeFileTarget(rawPath: $0, workspacePath: input.workspacePath)
        }

        let urlLimit = input.urlLimit > 0 ? input.urlLimit : defaultUrlLimit
        var urlGroups: [[ToolUrlPresentationTarget]] = []
        urlGroups.append(extractUrlsFromParameterStrings(input.parameterStrings, limit: urlLimit))
        if let detail = input.detail {
            urlGroups.append(extractHttpUrls(detail, limit: urlLimit))
        }
        if let result = input.resultText {
            urlGroups.append(extractHttpUrls(result, limit: urlLimit))
        }
        let urls = mergeUrlTargets(urlGroups, limit: urlLimit)

        return ToolTargetPresentationModel(fileTarget: fileTarget, urlTargets: urls)
    }

    /// Convenience for projected ToolEntry-shaped fields without a parameter bag.
    public static func makePresentation(
        file: String?,
        detail: String? = nil,
        workspacePath: String? = nil,
        urlLimit: Int = defaultUrlLimit
    ) -> ToolTargetPresentationModel {
        makePresentation(
            from: ToolTargetDetectionInput(
                file: file,
                detail: detail,
                workspacePath: workspacePath,
                urlLimit: urlLimit
            )
        )
    }

    public static func makeFileTarget(
        rawPath: String,
        workspacePath: String?
    ) -> ToolFilePresentationTarget? {
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxPathLength else { return nil }
        // Reject obvious URL-shaped strings as file targets — those belong in
        // the URL lane so Open never confuses a path callback with a link.
        if looksLikeHttpUrl(trimmed) { return nil }

        let absolute = resolveWorkspaceAbsolutePath(trimmed, workspacePath: workspacePath)
        let displayPath = displayPathRelativeToWorkspace(absolute, workspacePath: workspacePath)
        let label = fileTailLabel(displayPath.isEmpty ? trimmed : displayPath)
        return ToolFilePresentationTarget(
            rawPath: trimmed,
            displayLabel: label,
            absolutePath: absolute.isEmpty ? trimmed : absolute,
            displayPath: displayPath.isEmpty ? trimmed : displayPath
        )
    }

    // MARK: File path extraction

    /// Prefers well-known parameter keys over the first-class `file` field,
    /// matching desktop `extractToolFilePath`.
    public static func extractToolFilePath(
        parameterStrings: [String: String],
        filePath: String?
    ) -> String? {
        for key in filePathParameterKeys {
            if let value = parameterStrings[key] {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty, trimmed.count <= maxPathLength, !looksLikeHttpUrl(trimmed) {
                    return trimmed
                }
            }
        }
        let direct = filePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !direct.isEmpty, direct.count <= maxPathLength, !looksLikeHttpUrl(direct) else {
            return nil
        }
        return direct
    }

    // MARK: URL extraction (desktop urlPresentation parity)

    public static func normalizeHttpUrlTarget(_ input: String) -> ToolUrlPresentationTarget? {
        var trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxUrlLength else { return nil }
        trimmed = trimTrailingUrlPunctuation(trimmed)
        guard !trimmed.isEmpty else { return nil }

        guard let components = URLComponents(string: trimmed),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host,
            !host.isEmpty
        else {
            return nil
        }

        // Strip credentials + fragment (desktop URL.username/password/hash = '').
        var cleaned = components
        cleaned.user = nil
        cleaned.password = nil
        cleaned.fragment = nil
        guard let normalized = cleaned.url?.absoluteString, !normalized.isEmpty else {
            return nil
        }

        let origin: String
        if let o = cleaned.url?.originString {
            origin = o
        } else {
            let portPart: String
            if let port = cleaned.port {
                portPart = ":\(port)"
            } else {
                portPart = ""
            }
            origin = "\(scheme)://\(host)\(portPart)"
        }

        let displayHost =
            host.lowercased().hasPrefix("www.")
            ? String(host.dropFirst(4))
            : host

        return ToolUrlPresentationTarget(
            url: normalized,
            origin: origin,
            host: displayHost
        )
    }

    public static func extractHttpUrls(_ text: String, limit: Int = textUrlExtractLimit)
        -> [ToolUrlPresentationTarget]
    {
        let cap = max(0, limit)
        guard cap > 0, !text.isEmpty else { return [] }
        guard text.range(of: "https?://", options: .regularExpression) != nil else {
            return []
        }

        // Desktop: /\bhttps?:\/\/[^\s<>"'`]+/gi
        let pattern = #"\bhttps?://[^\s<>"'`]+"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        else {
            return []
        }

        let ns = text as NSString
        let matches = regex.matches(
            in: text, options: [], range: NSRange(location: 0, length: ns.length))
        var results: [ToolUrlPresentationTarget] = []
        var seen = Set<String>()
        for match in matches {
            guard match.numberOfRanges > 0 else { continue }
            let raw = ns.substring(with: match.range(at: 0))
            guard let target = normalizeHttpUrlTarget(raw), !seen.contains(target.url) else {
                continue
            }
            seen.insert(target.url)
            results.append(target)
            if results.count >= cap { break }
        }
        return results
    }

    public static func mergeUrlTargets(
        _ groups: [[ToolUrlPresentationTarget]],
        limit: Int = textUrlExtractLimit
    ) -> [ToolUrlPresentationTarget] {
        let cap = max(0, limit)
        guard cap > 0 else { return [] }
        var results: [ToolUrlPresentationTarget] = []
        var seen = Set<String>()
        for group in groups {
            for target in group {
                if seen.contains(target.url) { continue }
                seen.insert(target.url)
                results.append(target)
                if results.count >= cap { return results }
            }
        }
        return results
    }

    public static func extractUrlsFromParameterStrings(
        _ parameters: [String: String],
        limit: Int = defaultUrlLimit
    ) -> [ToolUrlPresentationTarget] {
        let cap = max(0, limit)
        guard cap > 0, !parameters.isEmpty else { return [] }
        // Stable key order so tests + UI don't flicker.
        let values = parameters.keys.sorted().compactMap { parameters[$0] }
        return mergeUrlTargets(values.map { extractHttpUrls($0, limit: cap) }, limit: cap)
    }

    // MARK: Path resolve / display

    public static func isAbsoluteFilePath(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed.hasPrefix("/") { return true }
        // Windows drive / UNC — accepted for cross-platform tool traces.
        if trimmed.count >= 3 {
            let c0 = trimmed[trimmed.startIndex]
            if c0.isLetter {
                let idx1 = trimmed.index(after: trimmed.startIndex)
                if trimmed[idx1] == ":" {
                    let idx2 = trimmed.index(after: idx1)
                    if trimmed[idx2] == "/" || trimmed[idx2] == "\\" { return true }
                }
            }
        }
        if trimmed.hasPrefix("\\\\") { return true }
        return false
    }

    public static func resolveWorkspaceAbsolutePath(
        _ filePath: String,
        workspacePath: String?
    ) -> String {
        let trimmedPath = filePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else { return "" }
        // Do not expand `~` — joining onto the workspace would fabricate a
        // wrong path (desktop ActivityPathDisplay contract).
        if trimmedPath.hasPrefix("~") { return trimmedPath }
        if isAbsoluteFilePath(trimmedPath) {
            return normalizePosixTraversal(trimmedPath)
        }
        guard let workspacePath else { return trimmedPath }
        let root = stripTrailingSeparator(
            workspacePath.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !root.isEmpty else { return trimmedPath }
        let separator: Character =
            root.contains("\\") && !root.contains("/") ? "\\" : "/"
        var relative = trimmedPath
        if relative.hasPrefix("./") {
            relative = String(relative.dropFirst(2))
        } else if relative.hasPrefix(".\\") {
            relative = String(relative.dropFirst(2))
        }
        return normalizePosixTraversal("\(root)\(separator)\(relative)")
    }

    public static func displayPathRelativeToWorkspace(
        _ filePath: String,
        workspacePath: String?
    ) -> String {
        let trimmedPath = filePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else { return "" }

        if let workspacePath {
            let trimmedWorkspace = stripTrailingSeparator(
                workspacePath.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            if !trimmedWorkspace.isEmpty {
                if trimmedPath == trimmedWorkspace { return "." }
                if startsWithSegment(trimmedPath, prefix: trimmedWorkspace) {
                    let relative = String(trimmedPath.dropFirst(trimmedWorkspace.count + 1))
                    return relative.isEmpty ? "." : relative
                }
            }
        }
        return tildifyHomePath(trimmedPath)
    }

    /// Last 1–2 path segments for monospaced inline labels (ToolActivityCards
    /// `fileTail` parity).
    public static func fileTailLabel(_ path: String, segments: Int = 2) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed == "." { return "." }
        let parts = trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" })
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !parts.isEmpty else { return trimmed }
        let take = max(1, segments)
        return parts.suffix(take).joined(separator: "/")
    }

    // MARK: Action policy + a11y

    public static func canPerform(
        _ action: ToolTargetInspectAction,
        onFile target: ToolFilePresentationTarget
    ) -> Bool {
        switch action {
        case .open, .reveal, .copyPath, .inspect:
            return !target.absolutePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    public static func canPerform(
        _ action: ToolTargetInspectAction,
        onUrl target: ToolUrlPresentationTarget
    ) -> Bool {
        switch action {
        case .open, .copyPath, .inspect:
            return !target.url.isEmpty
        case .reveal:
            // Reveal-in-Finder is file-only.
            return false
        }
    }

    public static func actionTitle(_ action: ToolTargetInspectAction) -> String {
        switch action {
        case .open: return "Open"
        case .reveal: return "Reveal in Files"
        case .copyPath: return "Copy path"
        case .inspect: return "Inspect"
        }
    }

    public static func actionSystemImage(_ action: ToolTargetInspectAction) -> String {
        switch action {
        case .open: return "arrow.up.right.square"
        case .reveal: return "folder"
        case .copyPath: return "doc.on.doc"
        case .inspect: return "info.circle"
        }
    }

    public static func accessibilityLabel(forFile target: ToolFilePresentationTarget) -> String {
        "Open file \(target.displayLabel)"
    }

    public static func accessibilityLabel(forUrl target: ToolUrlPresentationTarget) -> String {
        "Open link \(target.host)"
    }

    public static func accessibilityLabel(
        for action: ToolTargetInspectAction,
        file target: ToolFilePresentationTarget
    ) -> String {
        "\(actionTitle(action)) \(target.displayLabel)"
    }

    public static func accessibilityLabel(
        for action: ToolTargetInspectAction,
        url target: ToolUrlPresentationTarget
    ) -> String {
        switch action {
        case .copyPath:
            return "Copy URL \(target.host)"
        default:
            return "\(actionTitle(action)) \(target.host)"
        }
    }

    public static func fileActions(for target: ToolFilePresentationTarget)
        -> [ToolTargetInspectAction]
    {
        ToolTargetInspectAction.allCases.filter { canPerform($0, onFile: target) }
    }

    public static func urlActions(for target: ToolUrlPresentationTarget)
        -> [ToolTargetInspectAction]
    {
        // Prefer open + copy for links; inspect is available for the full URL.
        [.open, .copyPath, .inspect].filter { canPerform($0, onUrl: target) }
    }

    // MARK: Internals

    private static func looksLikeHttpUrl(_ value: String) -> Bool {
        let lower = value.lowercased()
        return lower.hasPrefix("http://") || lower.hasPrefix("https://")
    }

    private static func stripTrailingSeparator(_ value: String) -> String {
        var result = value
        while result.hasSuffix("/") || result.hasSuffix("\\") {
            result = String(result.dropLast())
        }
        return result
    }

    private static func startsWithSegment(_ haystack: String, prefix: String) -> Bool {
        if haystack == prefix { return true }
        guard haystack.hasPrefix(prefix) else { return false }
        let idx = haystack.index(haystack.startIndex, offsetBy: prefix.count)
        guard idx < haystack.endIndex else { return true }
        let next = haystack[idx]
        return next == "/" || next == "\\"
    }

    private static func normalizePosixTraversal(_ path: String) -> String {
        guard path.hasPrefix("/") else { return path }
        var stack: [String] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            if segment == "." { continue }
            if segment == ".." {
                if !stack.isEmpty { stack.removeLast() }
                continue
            }
            stack.append(String(segment))
        }
        return "/" + stack.joined(separator: "/")
    }

    private static func tildifyHomePath(_ filePath: String) -> String {
        // /Users/<user>/… → ~/…
        let pattern = #"^/Users/[^/]+/"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(
                in: filePath,
                options: [],
                range: NSRange(location: 0, length: (filePath as NSString).length)
            )
        else {
            return filePath
        }
        let ns = filePath as NSString
        let prefix = ns.substring(with: match.range)
        return "~/" + String(filePath.dropFirst(prefix.count))
    }

    private static func trimTrailingUrlPunctuation(_ input: String) -> String {
        var value = input
        while let last = value.last, ",.;:!?".contains(last) {
            value = String(value.dropLast())
        }
        value = stripUnbalancedTrailing(value, close: ")", open: "(")
        value = stripUnbalancedTrailing(value, close: "]", open: "[")
        value = stripUnbalancedTrailing(value, close: "}", open: "{")
        return value
    }

    private static func stripUnbalancedTrailing(
        _ value: String,
        close: Character,
        open: Character
    ) -> String {
        var next = value
        while next.last == close, countChar(next, close) > countChar(next, open) {
            next = String(next.dropLast())
        }
        return next
    }

    private static func countChar(_ value: String, _ needle: Character) -> Int {
        value.reduce(0) { $0 + ($1 == needle ? 1 : 0) }
    }
}

// MARK: - URL origin helper

private extension URL {
    /// `scheme://host[:port]` without path/query.
    var originString: String? {
        guard let scheme = scheme, let host = host else { return nil }
        if let port = port {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }
}
