#!/usr/bin/env swift

import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2,
      let requested = Int32(CommandLine.arguments[1]),
      requested > 0 else {
    fputs("usage: studio-acceptance-window-probe.swift <pid>\n", stderr)
    exit(2)
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
let matches = raw.compactMap { info -> [String: Any]? in
    guard let ownerPid = info[kCGWindowOwnerPID as String] as? Int,
          ownerPid == Int(requested),
          let layer = info[kCGWindowLayer as String] as? Int,
          layer == 0 else {
        return nil
    }
    let bounds = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
    guard width > 1, height > 1 else { return nil }
    return [
        "ownerName": info[kCGWindowOwnerName as String] as? String ?? "",
        "title": info[kCGWindowName as String] as? String ?? "",
        "width": width,
        "height": height
    ]
}

let payload: [String: Any] = [
    "pid": Int(requested),
    "visibleWindowCount": matches.count,
    "windows": matches
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([0x0A]))
