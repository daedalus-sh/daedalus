// swift-tools-version: 6.2
import PackageDescription

// Layout: `DaedalusFeature` is the whole iPhone and iPad product (UI, stores, networking, and the pure
// logic under Core/ that has no UI imports). `AppFeature` is the thin root the app target embeds.
// `WatchFeature` is the watch app, and `DaedalusShared` what the two apps say to each other.
// `DaedalusCoreFFI` is the Rust core (ios/core): the node link, the tunnel and its proxy, built by
// ios/scripts/build-core.sh for iOS only, so nothing the watch builds may depend on it.
let uiSettings: [SwiftSetting] = [
    .defaultIsolation(MainActor.self),
    .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
    .enableUpcomingFeature("InferIsolatedConformances"),
]

let package = Package(
    name: "DaedalusKit",
    platforms: [.iOS("27.0"), .watchOS("27.0")],
    products: [
        .library(name: "AppFeature", targets: ["AppFeature"]),
        .library(name: "WatchFeature", targets: ["WatchFeature"]),
    ],
    targets: [
        .binaryTarget(name: "DaedalusCoreFFI", path: "Frameworks/DaedalusCoreFFI.xcframework"),
        .target(name: "DaedalusShared"),
        .target(name: "DaedalusFeature", dependencies: ["DaedalusCoreFFI", "DaedalusShared"], swiftSettings: uiSettings),
        .target(name: "AppFeature", dependencies: ["DaedalusFeature"], swiftSettings: uiSettings),
        .target(name: "WatchFeature", dependencies: ["DaedalusShared"], swiftSettings: uiSettings),

        // MARK: Tests
        .testTarget(name: "DaedalusFeatureTests", dependencies: ["DaedalusFeature"], swiftSettings: uiSettings),
    ],
    swiftLanguageModes: [.v6]
)
