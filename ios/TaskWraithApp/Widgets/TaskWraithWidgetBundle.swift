// Widget extension entry point: the Live Activity plus the home-screen
// glance widget (running/last-run status board).

import SwiftUI
import WidgetKit

@main
struct TaskWraithWidgetBundle: WidgetBundle {
    var body: some Widget {
        TWGlanceWidget()
        // iOS 16.1 is where ActivityConfiguration appears. The app's floor is
        // 17.0 so this is always satisfied, but the availability annotation on
        // the widget itself still has to be honoured here.
        if #available(iOS 16.1, *) {
            TWRunActivityWidget()
        }
    }
}
