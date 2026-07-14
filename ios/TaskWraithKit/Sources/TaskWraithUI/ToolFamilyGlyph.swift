import SwiftUI

enum TWToolFamily: String {
    case file
    case edit
    case git
    case shell
    case search
    case task
    case mcp
    case browser
    case windowContext
    case delegate
    case yield
    case subthread
    case diagnostic
    case reasoning
    case plan
    case handoff
}

struct ToolFamilyGlyph: View {
    let toolName: String?
    let category: String?
    var size: CGFloat = 16

    private var family: TWToolFamily? {
        TWToolFamilyResolver.family(for: toolName, category: category)
    }

    var body: some View {
        if let family {
            ToolFamilyShape(family: family)
                .stroke(style: StrokeStyle(lineWidth: 1.65, lineCap: .round, lineJoin: .round))
                .frame(width: size, height: size)
        } else {
            Image(systemName: "wrench.and.screwdriver")
                .font(.system(size: size * 0.74, weight: .semibold))
                .frame(width: size, height: size)
        }
    }
}

enum TWToolFamilyResolver {
    static func family(for name: String?, category: String? = nil) -> TWToolFamily? {
        guard var normalized = normalizedToolName(name) else {
            return familyForCategory(category)
        }

        // Did the name carry an MCP / TaskWraith-broker namespace? A brokered
        // MCP call whose inner tool name can't be unwrapped still reads better as
        // "an MCP tool" (the plug) than as an undecorated wrench — mirrors
        // Electron toolNameToFamily's `strippedMcp` fallback.
        var strippedMcp = false

        if normalized.hasPrefix("mcp__") {
            strippedMcp = true
            let rest = normalized.dropFirst(5)
            if let range = rest.range(of: "__") {
                normalized = String(rest[range.upperBound...])
            }
        } else if normalized.hasPrefix("mcp_") {
            strippedMcp = true
            let prefixes = [
                "mcp_taskwraith-broker_",
                "mcp_taskwraith-broker-",
                "mcp_taskwraith_",
                "mcp_taskwraith-"
            ]
            for prefix in prefixes {
                if normalized.hasPrefix(prefix) {
                    normalized = String(normalized.dropFirst(prefix.count))
                    break
                }
            }
        } else if normalized.hasPrefix("taskwraith-broker__") {
            strippedMcp = true
            normalized = String(normalized.dropFirst("taskwraith-broker__".count))
        } else if normalized.hasPrefix("taskwraith_broker__") {
            strippedMcp = true
            normalized = String(normalized.dropFirst("taskwraith_broker__".count))
        } else if normalized.hasPrefix("taskwraith-broker_") {
            strippedMcp = true
            normalized = String(normalized.dropFirst("taskwraith-broker_".count))
        } else if normalized.hasPrefix("taskwraith_broker_") {
            strippedMcp = true
            normalized = String(normalized.dropFirst("taskwraith_broker_".count))
        } else if normalized.hasPrefix("taskwraith__") {
            strippedMcp = true
            normalized = String(normalized.dropFirst("taskwraith__".count))
        } else if normalized.hasPrefix("taskwraith_") {
            strippedMcp = true
            normalized = String(normalized.dropFirst("taskwraith_".count))
        }

        // Exact-name buckets (most specific first). iOS carries a 16-glyph
        // subset of Electron's 34 tool families (ToolFamilyIcon.tsx); families
        // with no dedicated iOS glyph route to their closest existing one so the
        // row reads at a glance instead of dropping to the generic wrench:
        //   patch → edit · pull-request/merge/ci → git · process/launch → shell
        //   fanout/roster → delegate · memory → search · audit/approval/status →
        //   diagnostic · canvas → browser (it IS a headless web surface).
        // image / audio / video / blackboard / wakeup have no near-match glyph
        // yet and stay on the wrench until dedicated shapes are drawn.
        switch normalized {
        case "delegate_to_subthread":
            return .delegate
        case "ensemble_yield":
            return .yield
        case "ensemble_send", "ensemble_fanout", "scout_brief":
            return .delegate
        case "list_subthreads", "read_subthread_result", "cancel_subthread", "collabtoolcall":
            return .subthread
        case "attached_window_capture", "attached_window_status":
            return .windowContext
        case "create_handoff_card", "open_in_ide", "open_in_ide_at_position",
            "reveal_in_finder", "ide_app_status", "ide_app_capabilities", "list_running_ides":
            return .handoff
        case "run_task", "list_active_runs", "cancel_active_run", "test_result_summary":
            return .task
        case "start_background_process", "list_background_processes",
            "read_background_process", "kill_background_process",
            "launch_list_targets", "launch_start", "launch_stop", "launch_status":
            return .shell
        case "list_chat_attachments", "inspect_chat_attachment":
            return .file
        case "web_fetch":
            return .browser
        case "scope_radar", "repo_convention_scan":
            return .search
        case "codex_plan", "goal_read", "goal_update", "update_goal", "goal_complete",
            "goal_blocked", "todo_write", "todowrite", "update_todo_list", "updatetodolist",
            "plan", "exit_plan_mode", "exitplanmode", "exitplan_mode", "exit_planmode",
            "prompt_task_normalize":
            return .plan
        case "codex_reasoning", "reasoning", "thinking":
            return .reasoning
        // ask_user_question shares the desktop's approval family (routed to
        // .diagnostic on iOS per the note above), not .task — a question card
        // is a user-gate like an approval, not run mechanics.
        case "approval_status", "ask_user_question", "askuserquestion",
            "provider_auth_status", "provider_usage_status", "run_timeline",
            "raw_provider_events", "get_diagnostics", "switch_auth_profile", "agent_delegation_role",
            "coherence_gate_check", "completion_claim_check", "evidence_pack_write",
            "creative_app_status", "creative_app_capabilities", "creative_project_snapshot",
            "creative_timeline_validate", "creative_timeline_ir", "creative_timeline_diff",
            "creative_timeline_import", "creative_applescript_dispatch", "creative_blender_python",
            "creative_midi_dispatch":
            return .diagnostic
        case "mcp_tool", "dynamic_tool", "mcp", "callmcptool", "call_mcp_tool", "use_tool":
            return .mcp
        default:
            break
        }

        // Pattern buckets — order matters (more-specific first).
        if normalized.hasSuffix("_thinking") || normalized.hasSuffix("_reasoning") { return .reasoning }
        if normalized.hasPrefix("git_") || normalized == "git" || normalized == "github_ci_status"
            || normalized == "githubcistatus" || normalized == "ci_status" || normalized == "cistatus"
            || normalized == "pull_request" || normalized == "pullrequest" || normalized == "merge"
        {
            return .git
        }
        if normalized.hasPrefix("browser_") { return .browser }
        // Canvas is TaskWraith's headless-web preview surface (render_html /
        // screenshot / click / eval); with no dedicated iOS glyph it borrows the
        // browser icon rather than the generic wrench.
        if normalized.hasPrefix("canvas_") { return .browser }
        if normalized.hasPrefix("tw_recall_") { return .search }
        if normalized.hasPrefix("tw_introspection_") { return .diagnostic }
        if normalized.hasPrefix("workspace_board_") { return .plan }
        if normalized.hasPrefix("appwatch_") { return .windowContext }
        if normalized.hasPrefix("ensemble_") || normalized == "list_ensemble_participants" {
            return .delegate
        }
        if normalized == "run_shell_command" || normalized == "runshellcommand"
            || normalized == "shell" || normalized == "bash"
            || normalized == "run_terminal_command" || normalized == "runterminalcommand"
            || normalized == "terminal"
        {
            return .shell
        }

        if [
            "grep_search", "grepsearch", "glob", "search", "grep", "rg",
            "google_web_search", "googlewebsearch", "web_search", "websearch",
            "workspace_search", "file_search", "tw_recall_find", "workspace_symbols",
            "find_files", "findfiles",
        ].contains(normalized) {
            return .search
        }

        if [
            "write_file", "writefile", "replace", "edit_file", "editfile", "edit",
            "create_file", "createfile", "delete_file", "deletefile",
            "create_directory", "createdirectory", "delete_path", "deletepath",
            "move_path", "movepath", "rename_path", "renamepath", "apply_patch",
            "applypatch", "str_replace", "strreplace", "str_replace_editor",
            "strreplaceeditor", "multiedit", "notebookedit",
        ].contains(normalized) {
            return .edit
        }

        if [
            "read_file", "readfile", "read", "list_directory", "listdirectory", "list_dir",
            "listdir", "open_workspace_file", "openworkspacefile",
        ].contains(normalized) {
            return .file
        }

        // A namespaced-but-unmatched MCP / broker tool still gets the plug icon —
        // it IS an MCP call, so that reads better than the undecorated wrench.
        if strippedMcp { return .mcp }

        return familyForCategory(category)
    }

    private static func normalizedToolName(_ name: String?) -> String? {
        let normalized =
            name?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let normalized, !normalized.isEmpty else { return nil }
        return normalized
    }

    private static func familyForCategory(_ category: String?) -> TWToolFamily? {
        switch category?.lowercased() {
        case "read":
            return .file
        case "write":
            return .edit
        case "shell":
            return .shell
        case "search":
            return .search
        case "task":
            return .task
        default:
            return nil
        }
    }
}

struct ToolFamilyShape: Shape {
    let family: TWToolFamily

    func path(in rect: CGRect) -> Path {
        let raw = Self.rawPath(for: family)
        let scale = min(rect.width, rect.height) / 24
        let transform = CGAffineTransform(
            a: scale,
            b: 0,
            c: 0,
            d: scale,
            tx: rect.midX - 12 * scale,
            ty: rect.midY - 12 * scale)
        return raw.applying(transform)
    }

    private static func rawPath(for family: TWToolFamily) -> Path {
        var path = Path()
        switch family {
        case .file:
            move(&path, 7.2, 3.3); line(&path, 15.7, 3); line(&path, 20.2, 7.4)
            line(&path, 20, 20.8); line(&path, 6.7, 20.5); line(&path, 6.3, 4.2)
            path.closeSubpath()
            move(&path, 15.4, 3.2); line(&path, 15.8, 7.7); line(&path, 20, 7.4)
            move(&path, 4.2, 6.1); line(&path, 4.5, 21.4); line(&path, 16.6, 21.1)
            move(&path, 9.1, 10.1); line(&path, 17.1, 9.8)
            move(&path, 9.2, 13.3); line(&path, 16.4, 13.2)
            move(&path, 9.1, 16.5); line(&path, 14.2, 16.7)
        case .edit:
            move(&path, 5, 6.1); line(&path, 16.6, 5.4); line(&path, 18.8, 16.9)
            line(&path, 6.3, 18.5); path.closeSubpath()
            move(&path, 7.3, 6.1); line(&path, 7.1, 8.1)
            move(&path, 10.5, 5.8); line(&path, 10.4, 7.8)
            move(&path, 13.8, 5.6); line(&path, 13.8, 7.5)
            move(&path, 6.2, 15.4); line(&path, 8.2, 15.2)
            move(&path, 16.5, 7.3); line(&path, 19.6, 10.1); line(&path, 11.6, 18.7)
            line(&path, 8.2, 19.5); line(&path, 9.1, 16.2); path.closeSubpath()
            move(&path, 14.9, 9.1); line(&path, 18, 12.1)
        case .git:
            move(&path, 7.1, 5.2)
            path.addCurve(
                to: CGPoint(x: 16.9, y: 15.2),
                control1: CGPoint(x: 9.6, y: 8),
                control2: CGPoint(x: 12, y: 10.4))
            move(&path, 7.4, 18.6)
            path.addCurve(
                to: CGPoint(x: 8, y: 8.3),
                control1: CGPoint(x: 9.4, y: 14.8),
                control2: CGPoint(x: 9.7, y: 12.4))
            move(&path, 9.7, 10.6)
            path.addCurve(
                to: CGPoint(x: 15.4, y: 6.6),
                control1: CGPoint(x: 11.8, y: 9.9),
                control2: CGPoint(x: 13.5, y: 8.8))
            circle(&path, 6.4, 4.7, 2.2); circle(&path, 16.4, 6.1, 2.2)
            circle(&path, 17.8, 16.3, 2.2); circle(&path, 6.5, 19, 2.2)
        case .shell:
            move(&path, 3.7, 5.1); line(&path, 20.4, 4.8); line(&path, 20.9, 18.7)
            line(&path, 3.2, 19.1); path.closeSubpath()
            move(&path, 4.2, 8.2); line(&path, 20.3, 8)
            move(&path, 7.1, 11.1); line(&path, 10.4, 13.5); line(&path, 7.2, 15.9)
            move(&path, 12.8, 16.2); line(&path, 17.4, 16.1)
            move(&path, 6.2, 6.6); line(&path, 6.2, 6.7)
            move(&path, 8.4, 6.5); line(&path, 8.5, 6.6)
        case .search:
            move(&path, 4.2, 5.2); line(&path, 14.6, 4.9)
            move(&path, 4.1, 8.4); line(&path, 11.4, 8.2)
            move(&path, 4.4, 11.8); line(&path, 9.6, 11.6)
            circle(&path, 12.3, 12.4, 4.7)
            move(&path, 15.8, 15.9); line(&path, 20, 20.3)
            move(&path, 10.7, 12.1); line(&path, 13.8, 11.9)
        case .task:
            move(&path, 5.2, 4.1); line(&path, 18.8, 4.5); line(&path, 18.4, 19.5)
            line(&path, 5.4, 19.1); path.closeSubpath()
            move(&path, 8, 8.2); line(&path, 9.5, 9.7); line(&path, 12.1, 7.1)
            move(&path, 13.8, 8.5); line(&path, 16.5, 8.4)
            move(&path, 8, 13.9); line(&path, 9.4, 15.2); line(&path, 12, 12.6)
            move(&path, 13.5, 14.1); line(&path, 16.8, 14)
            move(&path, 8.1, 17.1); line(&path, 10.5, 17)
            move(&path, 13.4, 17.1); line(&path, 16.1, 17)
            move(&path, 7.1, 4.2); line(&path, 7.3, 2.8); line(&path, 16.3, 3.1)
            line(&path, 16.5, 4.4)
        case .mcp:
            move(&path, 9.3, 8.5); line(&path, 14.9, 8.6); line(&path, 14.8, 14.1)
            path.addCurve(
                to: CGPoint(x: 11.6, y: 17.6),
                control1: CGPoint(x: 14.7, y: 16.3),
                control2: CGPoint(x: 13.3, y: 17.6))
            path.addCurve(
                to: CGPoint(x: 8.8, y: 14.2),
                control1: CGPoint(x: 9.8, y: 17.5),
                control2: CGPoint(x: 8.7, y: 16.1))
            path.closeSubpath()
            move(&path, 10.1, 4.5); line(&path, 10.1, 8.2)
            move(&path, 14.1, 4.4); line(&path, 13.9, 8.3)
            move(&path, 11.8, 17.6); line(&path, 11.7, 20.5)
            move(&path, 6.3, 12.1); line(&path, 8.8, 12.1)
            move(&path, 15, 12.1); line(&path, 17.8, 12.2)
            circle(&path, 4.6, 12, 1.4); circle(&path, 19.5, 12.3, 1.4)
        case .browser:
            move(&path, 3.8, 5.2); line(&path, 20.6, 5); line(&path, 20.3, 18.6)
            line(&path, 4, 18.9); path.closeSubpath()
            move(&path, 4.1, 8.3); line(&path, 20.2, 8.1)
            move(&path, 6.4, 6.7); line(&path, 6.5, 6.8)
            move(&path, 8.7, 6.6); line(&path, 8.8, 6.7)
            move(&path, 10.8, 11.1); line(&path, 15.7, 16.5); line(&path, 13.1, 16)
            line(&path, 12.2, 18.3); line(&path, 9.9, 12.2); path.closeSubpath()
            move(&path, 16.4, 10.9); line(&path, 18.8, 10.9); line(&path, 18.7, 13.2)
            move(&path, 17.4, 11.9); line(&path, 18.8, 10.9)
        case .windowContext:
            move(&path, 4, 5.1); line(&path, 20.2, 4.9); line(&path, 20, 18.8)
            line(&path, 4.3, 19.1); path.closeSubpath()
            move(&path, 4.4, 8.2); line(&path, 19.8, 8)
            move(&path, 7.1, 12.1); line(&path, 7.1, 9.8); line(&path, 9.3, 9.8)
            move(&path, 16.8, 9.8); line(&path, 19, 9.8); line(&path, 18.9, 12)
            move(&path, 18.8, 15.6); line(&path, 18.8, 17.4); line(&path, 16.6, 17.4)
            move(&path, 9.4, 17.4); line(&path, 7.2, 17.4); line(&path, 7.2, 15.5)
            move(&path, 11.2, 12.2); line(&path, 15.2, 14.2); line(&path, 12.3, 15.9)
            path.closeSubpath()
        case .delegate:
            move(&path, 3.6, 5.5); line(&path, 11.3, 5.2); line(&path, 11.5, 12.5)
            line(&path, 3.8, 12.8); path.closeSubpath()
            move(&path, 12.8, 11.6); line(&path, 20.4, 11.3); line(&path, 20.2, 18.7)
            line(&path, 12.9, 19); path.closeSubpath()
            move(&path, 8.1, 13.9)
            path.addCurve(
                to: CGPoint(x: 12.7, y: 15.8),
                control1: CGPoint(x: 9.8, y: 16.6),
                control2: CGPoint(x: 10.5, y: 16.8))
            move(&path, 10.9, 14.1); line(&path, 12.8, 15.8); line(&path, 10.8, 17.2)
            move(&path, 5.8, 8); line(&path, 9.1, 7.9)
            move(&path, 15, 14.3); line(&path, 18.3, 14.2)
        case .yield:
            move(&path, 4.1, 5.7); line(&path, 12.5, 5.4)
            path.addCurve(
                to: CGPoint(x: 19, y: 11.1),
                control1: CGPoint(x: 15.9, y: 5.4),
                control2: CGPoint(x: 18.8, y: 7.7))
            path.addCurve(
                to: CGPoint(x: 12.2, y: 18.4),
                control1: CGPoint(x: 19.3, y: 15.1),
                control2: CGPoint(x: 16.2, y: 18.4))
            line(&path, 7.4, 18.4)
            move(&path, 8.4, 3.5); line(&path, 4.2, 5.8); line(&path, 8.6, 8)
            move(&path, 7.1, 18.4); line(&path, 9.6, 15.8)
            move(&path, 7.1, 18.4); line(&path, 9.8, 20.9)
            move(&path, 11.3, 10.3); line(&path, 15.4, 10.2)
            move(&path, 11.2, 13.4); line(&path, 14.2, 13.3)
        case .subthread:
            move(&path, 4.4, 4.8); line(&path, 15.3, 4.5); line(&path, 15.4, 10.6)
            line(&path, 5, 10.9); path.closeSubpath()
            move(&path, 7.3, 10.8); line(&path, 6.1, 12.9); line(&path, 9.2, 10.8)
            move(&path, 7.6, 7.6); line(&path, 12.6, 7.4)
            move(&path, 8.5, 12.9); line(&path, 19.5, 12.6); line(&path, 19, 18.7)
            line(&path, 8.9, 19); path.closeSubpath()
            move(&path, 12, 18.9); line(&path, 10.5, 21.1); line(&path, 14, 18.9)
            move(&path, 11.3, 15.8); line(&path, 16.7, 15.6)
            move(&path, 3.2, 7.2); line(&path, 2.7, 7.2); line(&path, 2.9, 16); line(&path, 6.2, 16)
        case .diagnostic:
            move(&path, 4.3, 15.8)
            path.addCurve(
                to: CGPoint(x: 12.1, y: 6),
                control1: CGPoint(x: 4.8, y: 9.8),
                control2: CGPoint(x: 8.1, y: 6))
            path.addCurve(
                to: CGPoint(x: 19.7, y: 15.6),
                control1: CGPoint(x: 16.3, y: 6),
                control2: CGPoint(x: 19.2, y: 9.7))
            move(&path, 6.7, 16.6); line(&path, 17.3, 16.5)
            move(&path, 12.2, 14.8); line(&path, 15.8, 10.4)
            move(&path, 7.2, 13.3); line(&path, 8.7, 12.7)
            move(&path, 11.8, 8.4); line(&path, 11.8, 10)
            move(&path, 16.8, 13.3); line(&path, 15.3, 12.7)
            move(&path, 7.8, 19.5)
            path.addCurve(
                to: CGPoint(x: 10.2, y: 19.5),
                control1: CGPoint(x: 7.8, y: 21.2),
                control2: CGPoint(x: 10.2, y: 21.2))
            line(&path, 10.2, 16.6)
            move(&path, 16.1, 16.6); line(&path, 16.1, 19.5)
            path.addCurve(
                to: CGPoint(x: 18.7, y: 19.4),
                control1: CGPoint(x: 16.1, y: 21.3),
                control2: CGPoint(x: 18.7, y: 21.2))
        case .reasoning:
            move(&path, 7.1, 15.2)
            path.addCurve(
                to: CGPoint(x: 3.6, y: 10.9),
                control1: CGPoint(x: 4.8, y: 15),
                control2: CGPoint(x: 3.5, y: 13.2))
            path.addCurve(
                to: CGPoint(x: 8.2, y: 6.9),
                control1: CGPoint(x: 3.7, y: 8.2),
                control2: CGPoint(x: 5.8, y: 6.4))
            path.addCurve(
                to: CGPoint(x: 13.7, y: 4.6),
                control1: CGPoint(x: 9, y: 4.7),
                control2: CGPoint(x: 11.4, y: 3.7))
            path.addCurve(
                to: CGPoint(x: 16.5, y: 8.2),
                control1: CGPoint(x: 15.5, y: 5.3),
                control2: CGPoint(x: 16.4, y: 6.6))
            path.addCurve(
                to: CGPoint(x: 19.9, y: 12.2),
                control1: CGPoint(x: 18.7, y: 8.6),
                control2: CGPoint(x: 20.1, y: 10.1))
            path.addCurve(
                to: CGPoint(x: 15.9, y: 15.6),
                control1: CGPoint(x: 19.7, y: 14.5),
                control2: CGPoint(x: 17.9, y: 15.7))
            line(&path, 12.3, 15.6); line(&path, 8.8, 18.9); line(&path, 9.5, 15.4)
            path.closeSubpath()
            move(&path, 9.1, 10.7); line(&path, 11.2, 10.7); line(&path, 11.2, 8.9)
            move(&path, 11.2, 10.7); line(&path, 13.5, 13)
            move(&path, 14.8, 10.2); line(&path, 16.2, 10.2)
            circle(&path, 8.2, 10.7, 0.55); circle(&path, 14, 13.5, 0.55)
        case .plan:
            move(&path, 4.2, 5.3); line(&path, 9.3, 3.9); line(&path, 14.7, 5.4)
            line(&path, 19.8, 4.2); line(&path, 19.3, 18.5); line(&path, 14.2, 19.9)
            line(&path, 9, 18.3); line(&path, 4, 19.5); path.closeSubpath()
            move(&path, 9.3, 3.9); line(&path, 9, 18.3)
            move(&path, 14.7, 5.4); line(&path, 14.2, 19.9)
            move(&path, 16.4, 8.1); line(&path, 16.4, 13.9)
            move(&path, 16.4, 8.1); line(&path, 19, 9.3); line(&path, 16.4, 10.7)
            move(&path, 6.3, 9.4); line(&path, 8.1, 9)
            move(&path, 5.9, 13.2); line(&path, 7.7, 12.8)
        case .handoff:
            move(&path, 4.9, 5.5); line(&path, 19.2, 5.2); line(&path, 19, 18.6)
            line(&path, 5.2, 18.9); path.closeSubpath()
            circle(&path, 8.8, 9.3, 1.25)
            move(&path, 6.9, 12.4)
            path.addCurve(
                to: CGPoint(x: 10.8, y: 12.2),
                control1: CGPoint(x: 7.7, y: 11.2),
                control2: CGPoint(x: 9.8, y: 11.1))
            circle(&path, 15.7, 9.2, 1.25)
            move(&path, 13.8, 12.3)
            path.addCurve(
                to: CGPoint(x: 17.6, y: 12.1),
                control1: CGPoint(x: 14.7, y: 11.2),
                control2: CGPoint(x: 16.6, y: 11.1))
            move(&path, 8.3, 15.6); line(&path, 14.9, 15.5)
            move(&path, 13.3, 14.1); line(&path, 15, 15.5); line(&path, 13.3, 17)
            move(&path, 3.1, 13.9)
            path.addCurve(
                to: CGPoint(x: 5.5, y: 13.2),
                control1: CGPoint(x: 4.1, y: 13.3),
                control2: CGPoint(x: 4.7, y: 13.1))
            move(&path, 20.8, 10.8)
            path.addCurve(
                to: CGPoint(x: 18.9, y: 12.2),
                control1: CGPoint(x: 20.1, y: 11.6),
                control2: CGPoint(x: 19.6, y: 12))
        }
        return path
    }

    private static func move(_ path: inout Path, _ x: CGFloat, _ y: CGFloat) {
        path.move(to: CGPoint(x: x, y: y))
    }

    private static func line(_ path: inout Path, _ x: CGFloat, _ y: CGFloat) {
        path.addLine(to: CGPoint(x: x, y: y))
    }

    private static func circle(_ path: inout Path, _ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) {
        path.addEllipse(
            in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
    }
}
