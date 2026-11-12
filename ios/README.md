# Daedalus for iPhone and iPad

The box in your pocket: is it healthy, what is behind, what is every machine and every Claude session
doing, and the buttons for the things worth doing from a sofa. Detail stays on the web.

## How it reaches the box

The app is a **light node** of the box. Pairing (a QR code from Settings › Machines) gives it:

- a WireGuard client of the box, confined to two ports, that the app runs **inside itself**. No VPN
  profile and no Network Extension: nothing else on the device uses the tunnel, and the app works
  whether or not the device is on a VPN;
- a node key, with which it links to the controller like every machine and reports itself (battery, OS
  version, model, storage, app version) while it is open;
- an API token for `/api/v1`, the box's API for this app.

```
SwiftUI ── URLSession ── loopback CONNECT proxy ─┐
                                                 ├─ smoltcp TCP ─ WireGuard ─ UDP ─▶ the box
node link (the agent's protocol, pinned TLS) ────┘        <LAN address>:443 and the controller's port
```

Everything below the Swift line is Rust: `core/` is a small library over `agent/core`, the crate the
agent itself is built from. The contract with the box is [`docs/api.md`](docs/api.md).

## Layout

| Path | What |
|---|---|
| `Daedalus/`, `Daedalus.xcodeproj`, `Config/` | The thin app target: `@main`, assets, identity (`App.xcconfig`) |
| `Packages/DaedalusKit/Sources/DaedalusFeature/Core/` | Pure logic, Foundation only: the API, the contract's types, the pair link |
| `Packages/DaedalusKit/Sources/DaedalusFeature/` | `Box` (pairing, transport, calls), `NodeCore` (the Rust library), the screens |
| `core/` | The Rust library and its C header (`include/daedalus_ios.h`) |
| `scripts/build-core.sh` | Builds `core/` into `Packages/DaedalusKit/Frameworks/DaedalusCoreFFI.xcframework` |

## Building

iOS 27, Xcode 27, Swift 6. On a Mac with rustup:

```sh
ios/scripts/build-core.sh          # once, and after any change under ios/core or agent/core
open ios/Daedalus.xcodeproj
```

Checks that run without a Mac:

```sh
ios/core/gate.sh                   # the Rust library: fmt, clippy (Linux and both iOS targets), tests
```

The Swift under `Core/` is Foundation-only so it can also be compiled and tested on Linux with a
Swift toolchain. The screens are compiled by CI's Mac alone.

## Releasing

`.github/workflows/ios.yml` builds and tests every push that touches `ios/` or `agent/core/`.
Its `testflight` job ships a green `main` to TestFlight once the repository variable
`IOS_DEPLOY_ENABLED` is `true` and the `testflight` environment holds:

| Secret | What |
|---|---|
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | An App Store Connect API key (Admin role) |
| `ASC_KEY_P8_BASE64` | That key's `.p8`, base64 |

Signing is cloud-managed with that key. By hand, once:

1. Register the bundle id `com.santiagotoscanini.daedalus` (App IDs, explicit) at
   <https://developer.apple.com/account/resources/identifiers/add/bundleId>.
2. Create the app with it at <https://appstoreconnect.apple.com/apps> (the **+** beside "Apps", New App,
   platform iOS).
3. On a Mac with the key's `.p8` in `~/Downloads`: `ios/scripts/setup-ci.sh` (it sets the three secrets
   and the variable). The key itself is made at <https://appstoreconnect.apple.com/access/integrations/api>.
The version is `MARKETING_VERSION` in `Config/App.xcconfig`; the
build number is the workflow's run number.
