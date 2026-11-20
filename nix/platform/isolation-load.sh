# shellcheck shell=bash
# Runs INSIDE the rootless network namespace (isolation-guard.sh): loads the
# FLEET_ISO chain and puts the jump to it first in FORWARD.
#
# Parameters: RULES (the iptables-restore file).

# --noflush replaces the chain's contents in one transaction: idempotent, and
# an app no longer isolated leaves no rule behind.
iptables-restore --noflush "$RULES"

# The jump must come FIRST: netavark's own jump (NETAVARK_FORWARD) accepts
# every bridge's traffic, and a guard behind it guards nothing. netavark
# inserts its jump at the top whenever it finds it missing, so the position
# is checked, not only the presence.
if [ "$(iptables -S FORWARD | sed -n 2p)" != "-A FORWARD -j FLEET_ISO" ]; then
  while iptables -D FORWARD -j FLEET_ISO 2>/dev/null; do :; done
  iptables -I FORWARD 1 -j FLEET_ISO
fi
