#!/bin/sh
# The iOS library's gate, from a Linux box without Rust on it: fmt, clippy
# (-D warnings), the tests, and clippy for both iOS targets, in a throwaway
# rust container on the rustc the box builds the agent with
# (rust-toolchain.toml). Every cargo step is --locked. Prints one marker per
# part and "GATE OK" only when every part passed; exits non-zero otherwise.
# Usage: ios/core/gate.sh
#
# The repository's root is mounted, read-write: the crate builds the shared
# crate by path (agent/core), and cargo writes this crate's Cargo.lock.
# Nothing under app/ is touched.
#
# The iOS checks build C: the tunnel's boringtun uses ring, whose build
# compiles C and assembly for the target, and Debian has no compiler for
# Apple's. zig does (`zig cc -target aarch64-ios[-simulator]`), the one
# agent/gate.sh downloads into the cargo cache both gates share, pinned by
# its SHA-256. zig ships no iOS libc headers, and ring's C needs only the
# freestanding ones, so the wrapper adds zig's own macOS headers for the few
# libc ones ring includes (<assert.h>, <string.h>): Darwin's are the same
# on both. A clippy run links nothing, so no SDK is needed; the first real
# link is the Mac's (ios/scripts/build-core.sh).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
mkdir -p /tmp/agent-cargo /tmp/ios-core-target
set +e
podman run --rm -v "$root":/w -w /w/ios/core \
  -v /tmp/agent-cargo:/tmp/agent-cargo -v /tmp/ios-core-target:/tmp/ios-core-target \
  -e CARGO_HOME=/tmp/agent-cargo -e CARGO_TARGET_DIR=/tmp/ios-core-target \
  docker.io/library/rust:1.95.0-bookworm bash -c '
    set -u
    rustup component add clippy rustfmt >/dev/null 2>&1
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim >/dev/null 2>&1
    failed=0
    step() {
      name="$1"; shift
      echo "--- $name"
      if "$@" > /tmp/step.log 2>&1; then
        echo "GATE_${name}_OK"
      else
        failed=1
        grep -E "^(warning|error)|test result|FAILED|panicked" -A12 /tmp/step.log | head -120
        echo "GATE_${name}_FAILED"
      fi
    }
    step FMT cargo fmt --check
    step CLIPPY cargo clippy --locked --all-targets -- -D warnings
    step TEST cargo test --locked
    grep -E "test result" /tmp/step.log

    # zig: the C compiler for ring on the iOS targets (see the header).
    zig_version=0.14.1
    zig_sha256=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
    zig_dir="$CARGO_HOME/zig-$zig_version"
    if [ ! -x "$zig_dir/zig" ]; then
      curl -fsSL -o /tmp/zig.tar.xz "https://ziglang.org/download/$zig_version/zig-x86_64-linux-$zig_version.tar.xz" \
        || { echo "downloading zig failed"; exit 1; }
      echo "$zig_sha256  /tmp/zig.tar.xz" | sha256sum -c --quiet \
        || { echo "zig $zig_version does not match its pinned SHA-256"; exit 1; }
      mkdir -p "$zig_dir" && tar -xJf /tmp/zig.tar.xz -C "$zig_dir" --strip-components=1
    fi
    export ZIG_GLOBAL_CACHE_DIR="$CARGO_HOME/zig-cache"
    zcc() {
      printf "%s\n" "#!/bin/bash" "out=(); skip=0" \
        "for a in \"\$@\"; do if [ \$skip = 1 ]; then skip=0; continue; fi" \
        "  case \"\$a\" in -arch|-isysroot) skip=1;; -mios-version-min=*|-mios-simulator-version-min=*|-miphoneos-version-min=*|-mtargetos=*|--target=*) ;; *) out+=(\"\$a\");; esac; done" \
        "exec $zig_dir/zig cc -target $2 -isystem $zig_dir/lib/libc/include/any-macos-any \"\${out[@]}\"" > "/usr/local/bin/$1"
      chmod 755 "/usr/local/bin/$1"
    }
    zcc zcc-aarch64-ios aarch64-ios
    zcc zcc-aarch64-ios-sim aarch64-ios-simulator
    printf "%s\n" "#!/bin/sh" "exec $zig_dir/zig ar \"\$@\"" > /usr/local/bin/zar
    chmod 755 /usr/local/bin/zar
    export CC_aarch64_apple_ios=/usr/local/bin/zcc-aarch64-ios AR_aarch64_apple_ios=/usr/local/bin/zar
    export CC_aarch64_apple_ios_sim=/usr/local/bin/zcc-aarch64-ios-sim AR_aarch64_apple_ios_sim=/usr/local/bin/zar
    # cc-rs asks xcrun for the SDK unless SDKROOT names a directory; the
    # wrapper drops the -isysroot it then passes.
    mkdir -p /tmp/ios-sdk
    export SDKROOT=/tmp/ios-sdk
    step IOS cargo clippy --locked --lib --target aarch64-apple-ios -- -D warnings
    step IOS_SIM cargo clippy --locked --lib --target aarch64-apple-ios-sim -- -D warnings
    if [ "$failed" = 0 ]; then echo "GATE OK"; else echo "GATE FAILED"; exit 1; fi
  '
status=$?
set -e
exit $status
