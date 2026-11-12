# Daedalus (iPhone and iPad app): agent notes

- This folder is the native app for the control plane in `app/`. Its server side is `/api/v1`
  (`app/src/host/api/v1/`) and pairing (`app/src/host/pair.ts`); the contract is `docs/api.md`, and a
  change to either side is a change there in the same commit. The app never uses MCP or server functions.
- The app is a light node: `core/` (Rust) runs its WireGuard tunnel, its link to the controller and a
  loopback proxy in-process, over `agent/core`. `NodeCore.swift` is the only file that calls it;
  `core/include/daedalus_ios.h` is its interface. After changing Rust, run `ios/core/gate.sh`.
- Keep the app target thin (`Daedalus/`: @main, assets). All code lives in `Packages/DaedalusKit`:
  `Sources/DaedalusFeature` (UI, stores, transport) and `Sources/AppFeature` (RootView).
- `Sources/DaedalusFeature/Core/` is pure logic: Foundation only, no UIKit/SwiftUI. New logic that can be
  pure goes there, with a test; it is the only Swift that can be compiled off a Mac.
- Every screen reads through a `Feed` (keeps the last value on screen while refreshing) and polls with
  `.task(id: box.epoch)`, so it stops in the background and starts fresh on return.
- Something that changes the box goes through `ActionButton` or an explicit confirmation, and shows the
  box's own refusal text.
- Don't hand-edit `project.pbxproj` to add files: `Daedalus/` is a synchronized folder, and package files
  are picked up automatically.
- Targets: iOS 27, Swift 6 language mode, default MainActor isolation. Use `@Observable`, not
  ObservableObject. Use Swift Testing (`@Test`, `#expect`), not XCTest.
- **A closure or method that UIKit or SwiftUI may call off the main thread must be `@Sendable` or
  `nonisolated` and take plain values.** With default MainActor isolation anything else is compiled as
  main-actor code, and Swift 6 traps (`_dispatch_assert_queue_fail`) when it runs elsewhere. Nothing warns
  at compile time. `UIColor { traits in … }` providers, `Canvas` renderers and `Shape.path(in:)` are the
  known cases; `ThemeThreadingTests` guards the ones here.
- Model types that cross actors are `nonisolated struct …: Codable, Sendable`.
- App identity and versioning live only in `Config/App.xcconfig`.
- Test: `cd ios/Packages/DaedalusKit && xcodebuild test -scheme DaedalusKit -destination 'platform=iOS Simulator,name=<an available iPhone>'`
- Build: `ios/scripts/build-core.sh`, then `cd ios && xcodebuild build -project Daedalus.xcodeproj -scheme Daedalus -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`
