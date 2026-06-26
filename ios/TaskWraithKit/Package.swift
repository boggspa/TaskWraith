// swift-tools-version: 6.0
import PackageDescription

// TaskWraithKit — the portable Swift core of the iOS companion.
//
// Pure CryptoKit + Foundation port of `src/shared/e2ee` (the
// taskwraith-e2ee-v1 protocol) plus the relay transport client and Codable
// domain models. No UIKit/SwiftUI here, so it builds + tests on macOS via
// `swift test` (the SwiftUI app in ../TaskWraithApp links against it).
//
// The InteropVectors test asserts byte-equality against the golden vectors in
// src/shared/e2ee/crossImplVectors.test.ts — the cross-implementation contract.
let package = Package(
    name: "TaskWraithKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "TaskWraithKit", targets: ["TaskWraithKit"]),
        // SwiftUI surface (views + view model). Pure SwiftUI so `swift build`
        // compile-checks it on macOS; the runnable iOS app target (App/) links
        // it. See App/README.md.
        .library(name: "TaskWraithUI", targets: ["TaskWraithUI"]),
        // Headless phone for the live Swift↔Node interop e2e (T4d). The Node
        // harness (ios/interop/) spawns this and drives the Mac side.
        .executable(name: "tw-interop-cli", targets: ["tw-interop-cli"])
    ],
    dependencies: [
        .package(url: "https://github.com/simonbs/Runestone.git", from: "0.5.0"),
        .package(url: "https://github.com/simonbs/TreeSitterLanguages.git", from: "0.1.10")
    ],
    targets: [
        .target(name: "TaskWraithKit"),
        .target(
            name: "TaskWraithUI",
            dependencies: [
                "TaskWraithKit",
                .product(name: "Runestone", package: "Runestone", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterBashRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterCRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterCPPRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterCSSRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterHTMLRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterJavaScriptRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterJSONRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterMarkdownRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterPythonRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterSwiftRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterTOMLRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterTSXRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterTypeScriptRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS])),
                .product(name: "TreeSitterYAMLRunestone", package: "TreeSitterLanguages", condition: .when(platforms: [.iOS]))
            ],
            resources: [.process("Resources")]
        ),
        .executableTarget(name: "tw-interop-cli", dependencies: ["TaskWraithKit"]),
        .testTarget(
            name: "TaskWraithKitTests",
            dependencies: ["TaskWraithKit"]
        ),
        .testTarget(
            name: "TaskWraithUITests",
            dependencies: ["TaskWraithUI"]
        )
    ]
)
