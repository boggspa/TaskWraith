import Foundation

/// Workspace display naming — a 1:1 port of `src/shared/workspaceDisplayName.ts`.
///
/// The desktop composer's above-row resolves a workspace's label through this
/// ladder (git remote → repo root → folder path), so a checkout whose FOLDER is
/// named `AGBench` but whose REMOTE is `TaskWraith` reads as "TaskWraith". iOS
/// was showing the Mac-projected `displayName` raw, which is the folder root
/// name — hence the same workspace read as "TaskWraith" on desktop and
/// "AGBench" in the phone's composer pill.
///
/// Kept as its own file, mirroring the TS module's shape function-for-function,
/// so the two implementations can be diffed by eye when either changes.
public enum TWWorkspaceDisplayName {
    /// Legacy workspace labels from the AGBench → TaskWraith rebrand. Matches
    /// `LEGACY_WORKSPACE_LABELS`; a stored label from before the rename is
    /// rewritten rather than migrated, because the folder on disk keeps its
    /// old name.
    static let legacyLabels: Set<String> = ["AGBench", "agbench"]

    /// Last path component, tolerant of either separator and trailing slashes.
    public static func pathBasename(_ value: String?) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var stripped = trimmed
        while stripped.hasSuffix("/") || stripped.hasSuffix("\\") {
            stripped.removeLast()
        }
        if stripped.isEmpty { return "" }
        let parts = stripped.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        return parts.last.map(String.init) ?? stripped
    }

    public static func formatWorkspaceDisplayName(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return legacyLabels.contains(trimmed) ? "TaskWraith" : trimmed
    }

    /// Project name from a git remote URL. Handles both URL forms
    /// (`https://host/owner/repo.git`) and scp-like forms
    /// (`git@host:owner/repo.git`), and strips the `.git` suffix.
    ///
    /// Returns the REPO segment only, never `owner/repo`: the phone pill is
    /// already tight, and the owner adds no disambiguation the user needs
    /// while looking at one workspace.
    public static func gitRemoteProjectName(_ remoteUrl: String?) -> String {
        let trimmed = (remoteUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }

        // Drop any query/fragment, then trailing separators.
        var withoutSuffix = trimmed
        if let cut = withoutSuffix.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            withoutSuffix = String(withoutSuffix[withoutSuffix.startIndex..<cut])
        }
        while withoutSuffix.hasSuffix("/") || withoutSuffix.hasSuffix("\\") {
            withoutSuffix.removeLast()
        }

        var candidate = ""
        if let parsed = URL(string: withoutSuffix), parsed.scheme != nil, !parsed.path.isEmpty {
            candidate = pathBasename(parsed.path)
        } else if let range = withoutSuffix.range(of: #"^[^@\s]+@[^:\s]+:(.+)$"#, options: .regularExpression) {
            // scp-like: take everything after the first colon.
            let matched = String(withoutSuffix[range])
            if let colon = matched.firstIndex(of: ":") {
                candidate = pathBasename(String(matched[matched.index(after: colon)...]))
            }
        } else {
            candidate = pathBasename(withoutSuffix)
        }

        if candidate.lowercased().hasSuffix(".git") {
            candidate = String(candidate.dropLast(4))
        }
        return candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The desktop's resolution order. A stored `displayName` only wins when it
    /// is something the user actually chose — when it is merely the folder name
    /// (or a legacy label), the repo name takes over.
    public static func resolve(
        displayName: String?,
        path: String?,
        repoRoot: String?,
        remoteUrl: String?
    ) -> String {
        let rawDisplayName = (displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedDisplayName = formatWorkspaceDisplayName(rawDisplayName)
        let rawPathBasename = pathBasename(path)
        let pathLabel = formatWorkspaceDisplayName(rawPathBasename)
        let repoSource = gitRemoteProjectName(remoteUrl)
        let repoLabel = formatWorkspaceDisplayName(
            repoSource.isEmpty ? pathBasename(repoRoot) : repoSource)

        let displayLooksDefault =
            rawDisplayName.isEmpty
            || rawDisplayName == rawPathBasename
            || resolvedDisplayName == pathLabel
            || legacyLabels.contains(rawDisplayName)

        if !repoLabel.isEmpty && displayLooksDefault { return repoLabel }
        if !resolvedDisplayName.isEmpty { return resolvedDisplayName }
        if !repoLabel.isEmpty { return repoLabel }
        if !pathLabel.isEmpty { return pathLabel }
        return "Workspace"
    }
}
