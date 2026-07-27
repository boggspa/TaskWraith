// Widget extension entry point.
//
// Live Activities only for now — no home-screen widgets. The bundle exists so
// the Live Activity has a target to live in; adding a home-screen widget later
// means adding it to `body` here.

import SwiftUI
import WidgetKit

@main
struct TaskWraithWidgetBundle: WidgetBundle {
    var body: some Widget {
        // iOS 16.1 is where ActivityConfiguration appears. The app's floor is
        // 17.0 so this is always satisfied, but the availability annotation on
        // the widget itself still has to be honoured here.
        if #available(iOS 16.1, *) {
            TWRunActivityWidget()
        }
    }
}
