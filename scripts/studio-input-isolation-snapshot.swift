#!/usr/bin/env swift

import AppKit
import Foundation

struct StudioInputIsolationSnapshot: Codable {
    let recordedAt: String
    let frontmostPid: Int32?
    let frontmostBundleIdentifier: String?
    let targetPid: Int32
    let targetIsActive: Bool
    let cursorX: Double
    let cursorY: Double
}

func writeSnapshot(targetPid: Int32) throws {
    let frontmost = NSWorkspace.shared.frontmostApplication
    let target = targetPid > 0
        ? NSRunningApplication(processIdentifier: pid_t(targetPid))
        : nil
    let cursor = NSEvent.mouseLocation
    let receipt = StudioInputIsolationSnapshot(
        recordedAt: ISO8601DateFormatter().string(from: Date()),
        frontmostPid: frontmost?.processIdentifier,
        frontmostBundleIdentifier: frontmost?.bundleIdentifier,
        targetPid: targetPid,
        targetIsActive: target?.isActive ?? false,
        cursorX: cursor.x,
        cursorY: cursor.y
    )
    FileHandle.standardOutput.write(try JSONEncoder().encode(receipt))
    FileHandle.standardOutput.write(Data([0x0A]))
}

if CommandLine.arguments.count == 2,
   let targetPid = Int32(CommandLine.arguments[1])
{
    try writeSnapshot(targetPid: targetPid)
} else if CommandLine.arguments.count == 3,
          CommandLine.arguments[1] == "--activate",
          let targetPid = Int32(CommandLine.arguments[2]),
          let application = NSRunningApplication(
              processIdentifier: pid_t(targetPid)
          ),
          application.activate(options: [.activateAllWindows])
{
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline &&
        NSWorkspace.shared.frontmostApplication?.processIdentifier != targetPid
    {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else {
        fputs("could not restore the original foreground application\n", stderr)
        exit(2)
    }
    try writeSnapshot(targetPid: targetPid)
} else {
    fputs(
        "usage: studio-input-isolation-snapshot.swift <target-pid> | --activate <pid>\n",
        stderr
    )
    exit(2)
}
