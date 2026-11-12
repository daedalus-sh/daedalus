#!/bin/sh
# Build the iOS library (ios/core, Rust) for the device and the simulator
# and wrap both in DaedalusCoreFFI.xcframework, where DaedalusKit's binary
# target expects it. On a Mac with Xcode and rustup; runnable from any
# directory. ios/core/rust-toolchain.toml names the toolchain and both
# targets, and rustup installs them on first use.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
core="$here/../core"
out="$here/../Packages/DaedalusKit/Frameworks/DaedalusCoreFFI.xcframework"
export IPHONEOS_DEPLOYMENT_TARGET=27.0

cd "$core"
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build --release --locked --lib --target "$target"
done

rm -rf "$out"
mkdir -p "$(dirname "$out")"
xcodebuild -create-xcframework \
  -library "$core/target/aarch64-apple-ios/release/libdaedalus_ios.a" -headers "$core/include" \
  -library "$core/target/aarch64-apple-ios-sim/release/libdaedalus_ios.a" -headers "$core/include" \
  -output "$out"
echo "built $out"
