import Testing

@testable import TaskWraithUI

/// Locks the iOS tool-family resolver against Electron's `toolNameToFamily`
/// (src/renderer/src/components/icons/ToolFamilyIcon.tsx). iOS renders a
/// 16-glyph subset of Electron's 34 families, so several families intentionally
/// route to their closest existing glyph (documented in TWToolFamilyResolver).
/// These cases guard both the shared vocabulary and those deliberate routes so
/// transcript tool rows don't silently regress to the generic wrench.
@Suite("Tool family resolver parity")
struct ToolFamilyResolverParityTests {
    private func family(_ name: String?, category: String? = nil) -> TWToolFamily? {
        TWToolFamilyResolver.family(for: name, category: category)
    }

    @Test func coreFamiliesResolve() {
        #expect(family("read_file") == .file)
        #expect(family("write_file") == .edit)
        #expect(family("apply_patch") == .edit)  // no iOS patch glyph → edit
        #expect(family("run_shell_command") == .shell)
        #expect(family("git_status") == .git)
        #expect(family("workspace_search") == .search)
        #expect(family("run_task") == .task)
        #expect(family("browser_navigate") == .browser)
        #expect(family("delegate_to_subthread") == .delegate)
        #expect(family("ensemble_yield") == .yield)
    }

    @Test func shellAndSearchAliasesMatchElectron() {
        // Aliases Electron grew that iOS previously dropped to the wrench.
        #expect(family("bash") == .shell)
        #expect(family("terminal") == .shell)
        #expect(family("run_terminal_command") == .shell)
        #expect(family("grep") == .search)
        #expect(family("glob") == .search)
        #expect(family("rg") == .search)
        #expect(family("web_search") == .search)
        #expect(family("find_files") == .search)
        // Edit aliases (path mutations) that were missing.
        #expect(family("move_path") == .edit)
        #expect(family("rename_path") == .edit)
        #expect(family("create_directory") == .edit)
    }

    @Test func githubFamiliesRouteToGit() {
        #expect(family("pull_request") == .git)
        #expect(family("git_create_pr") == .git)
        #expect(family("merge") == .git)
        #expect(family("git_merge") == .git)
        #expect(family("github_ci_status") == .git)
        #expect(family("ci_status") == .git)
    }

    @Test func processLaunchRouteToShell() {
        #expect(family("start_background_process") == .shell)
        #expect(family("kill_background_process") == .shell)
        #expect(family("launch_start") == .shell)
        #expect(family("launch_status") == .shell)
    }

    @Test func ideHandoffFamily() {
        #expect(family("create_handoff_card") == .handoff)
        #expect(family("open_in_ide") == .handoff)
        #expect(family("reveal_in_finder") == .handoff)
        #expect(family("list_running_ides") == .handoff)
    }

    @Test func ensembleAndDelegateRoutes() {
        #expect(family("ensemble_send") == .delegate)
        #expect(family("ensemble_fanout") == .delegate)
        #expect(family("ensemble_bossman_control") == .delegate)  // ensemble_ prefix
        #expect(family("list_ensemble_participants") == .delegate)
        #expect(family("scout_brief") == .delegate)
    }

    @Test func recallIntrospectionBoardWatch() {
        #expect(family("tw_recall_find") == .search)          // memory → search
        #expect(family("tw_recall_read_events") == .search)
        #expect(family("tw_introspection_run") == .diagnostic)  // audit → diagnostic
        #expect(family("coherence_gate_check") == .diagnostic)
        #expect(family("workspace_board_add") == .plan)
        #expect(family("appwatch_status") == .windowContext)
    }

    @Test func reasoningAndPlan() {
        #expect(family("thinking") == .reasoning)
        #expect(family("codex_reasoning") == .reasoning)
        #expect(family("some_custom_thinking") == .reasoning)  // *_thinking suffix
        #expect(family("update_goal") == .plan)
        #expect(family("prompt_task_normalize") == .plan)
    }

    @Test func statusApprovalRouteToDiagnostic() {
        #expect(family("approval_status") == .diagnostic)
        #expect(family("provider_auth_status") == .diagnostic)
        #expect(family("run_timeline") == .diagnostic)
    }

    @Test func canvasBorrowsBrowserGlyph() {
        #expect(family("web_fetch") == .browser)
        #expect(family("canvas_render_html") == .browser)  // canvas_ prefix
        #expect(family("canvas_screenshot") == .browser)
    }

    /// Brokered MCP calls whose inner tool name unwraps to a known family keep
    /// that family; unknown inner names fall back to the plug, never the wrench.
    @Test func mcpNamespaceHandling() {
        #expect(family("mcp__TaskWraith__delegate_to_subthread") == .delegate)
        #expect(family("mcp__someserver__totally_unknown_tool") == .mcp)
        #expect(family("mcp_tool") == .mcp)
        #expect(family("use_tool") == .mcp)
    }

    /// Families with no near-match iOS glyph deliberately stay unresolved (the
    /// caller draws the generic wrench). Documented so a future glyph addition
    /// is a conscious change, not an accidental one.
    @Test func mediaAndUnmappedStayGeneric() {
        #expect(family("image_edit") == nil)
        #expect(family("svg_rasterize") == nil)
        #expect(family("audio_mix") == nil)
        #expect(family("video_probe") == nil)
        #expect(family("blackboard_post") == nil)
        #expect(family("schedule_wakeup") == nil)
    }

    @Test func categoryFallback() {
        #expect(family(nil, category: "read") == .file)
        #expect(family("mystery_tool", category: "shell") == .shell)
        #expect(family("mystery_tool", category: nil) == nil)
    }
}
