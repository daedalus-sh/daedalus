// swift-tools-version: 6.2
import PackageDescription

// Layout: `DaedalusFeature` is the whole product (UI, stores, networking, and the pure logic under
// Core/ that has no UI imports). `AppFeature` is the thin root the app target embeds.
// `DaedalusCoreFFI` is the Rust core (ios/core): the node link, the tunnel and its proxy, built by ios/scripts/build-core.sh.
let uiSettings: [SwiftSetting] = [
    .defaultIsolation(MainActor.self),
    .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
    .enableUpcomingFeature("InferIsolatedConformances"),
]

let package = Package(
    name: "DaedalusKit",
    platforms: [.iOS("27.0")],
    products: [
        .library(name: "AppFeature", targets: ["AppFeature"]),
    ],
    targets: [
        .binaryTarget(name: "DaedalusCoreFFI", path: "Frameworks/DaedalusCoreFFI.xcframework"),
        .target(name: "DaedalusFeature", dependencies: ["DaedalusCoreFFI"], swiftSettings: uiSettings),
        .target(name: "AppFeature", dependencies: ["DaedalusFeature"], swiftSettings: uiSettings),

        // MARK: Tests
        .testTarget(name: "DaedalusFeatureTests", dependencies: ["DaedalusFeature"], swiftSettings: uiSettings),
    ],
    swiftLanguageModes: [.v6]
)
