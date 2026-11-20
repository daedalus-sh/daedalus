# shellcheck shell=bash
# The routed half of isolation, run before and after an isolated app's
# container starts. $1 is the app whose container is starting: a bridge off
# its pin fails that app's start (its guard would be guarding the wrong
# addresses) and is only reported for the others, so one renumbered bridge
# takes down no other app.
#
# Parameters: PINS (file, one `<app> <network> <subnet>` per line), LOAD
# (isolation-load.sh, wrapped), LOCK (lock file path).
self=$1

# One guard at a time: the isolated apps start together (a switch, a boot),
# and two of them moving the jump at once would leave two.
exec 9>"$LOCK"
flock -w 60 9

while read -r app net pin; do
  have=$(podman network inspect "$net" --format '{{range .Subnets}}{{.Subnet}} {{end}}' || true)
  if [ "$have" != "$pin " ]; then
    echo "iso guard: $net is on '$have', not its pin $pin" >&2
    [ "$self" != "$app" ] || exit 1
  fi
done <"$PINS"

# ONE entry into the namespace for the whole load. Each `podman unshare
# --rootless-netns` can land in a different namespace while none is settled
# (a boot: the first containers are still creating it), and a chain made by
# one call was then missing for the next ("Chain 'FLEET_ISO' does not exist"),
# failing the start and, with it, every unit that requires this one.
podman unshare --rootless-netns "$LOAD"
