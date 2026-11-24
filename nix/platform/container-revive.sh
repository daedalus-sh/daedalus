# Restart a container that died behind its unit, a bounded number of times.
#
# The wrapper sets CONTAINERS (declared names, space separated), STATE_DIR,
# LOCK (the rebuild lock) and the operator's USER_NAME, USER_GROUP, USER_HOME
# and USER_RUNTIME. Constants below are the whole policy.
#
# Every exit here is 0: a sweep that cannot see is a sweep that does nothing,
# and this unit runs each minute.
MAX_RESTARTS=3    # per container, until it has stayed up for STABLE_AFTER
STABLE_AFTER=1800 # seconds since its last revive before the count is forgotten

mkdir -p "$STATE_DIR/seen" "$STATE_DIR/count" "$STATE_DIR/gave-up" "$STATE_DIR/total"

# A box that is booting or shutting down is restarting things itself.
case "$(systemctl is-system-running 2>/dev/null || true)" in
  running | degraded) ;;
  *) exit 0 ;;
esac

# So is a rebuild: the verbs hold the lock for theirs, a hand one shows as the
# switch unit. Probe only; the sweep never makes a rebuild wait.
if [ -e "$LOCK" ] && ! flock -n -s "$LOCK" true; then
  exit 0
fi
if systemctl is-active --quiet nixos-rebuild-switch-to-configuration.service; then
  exit 0
fi

# What runs, asked once. A podman that does not answer is not "nothing runs".
if ! running=$(setpriv --reuid "$USER_NAME" --regid "$USER_GROUP" --init-groups --inh-caps=-all \
  env -i HOME="$USER_HOME" XDG_RUNTIME_DIR="$USER_RUNTIME" PATH="$PATH" \
  podman ps --format '{{.Names}}' 2>/dev/null); then
  echo "podman did not answer; nothing judged this sweep"
  exit 0
fi

now=$(date +%s)
revive=()

for name in $CONTAINERS; do
  unit="podman-$name.service"
  [ -e "$STATE_DIR/total/$name" ] || echo 0 >"$STATE_DIR/total/$name"

  if grep -qxF -- "$name" <<<"$running"; then
    rm -f "$STATE_DIR/seen/$name"
    if [ -e "$STATE_DIR/count/$name" ]; then
      last=$(stat -c %Y "$STATE_DIR/count/$name" 2>/dev/null || echo "$now")
      if [ $((now - last)) -ge "$STABLE_AFTER" ]; then
        rm -f "$STATE_DIR/count/$name" "$STATE_DIR/gave-up/$name"
      fi
    fi
    continue
  fi

  # Not running. Only an ACTIVE unit says it should be: inactive is stopped on
  # purpose, failed is systemd's to report, activating is a start under way.
  if [ "$(systemctl is-active "$unit" 2>/dev/null || true)" != active ]; then
    rm -f "$STATE_DIR/seen/$name"
    continue
  fi

  # Twice in a row, so a container between two states is never a crash.
  if [ ! -e "$STATE_DIR/seen/$name" ]; then
    : >"$STATE_DIR/seen/$name"
    continue
  fi
  rm -f "$STATE_DIR/seen/$name"

  n=0
  [ -e "$STATE_DIR/count/$name" ] && n=$(cat "$STATE_DIR/count/$name" 2>/dev/null || echo 0)
  case "$n" in '' | *[!0-9]*) n=0 ;; esac

  if [ "$n" -ge "$MAX_RESTARTS" ]; then
    if [ ! -e "$STATE_DIR/gave-up/$name" ]; then
      : >"$STATE_DIR/gave-up/$name"
      echo "$name: gone again after $MAX_RESTARTS restarts; left down for the operator"
    fi
    continue
  fi

  echo $((n + 1)) >"$STATE_DIR/count/$name"
  total=$(cat "$STATE_DIR/total/$name" 2>/dev/null || echo 0)
  case "$total" in '' | *[!0-9]*) total=0 ;; esac
  echo $((total + 1)) >"$STATE_DIR/total/$name"
  echo "$name: its container is gone and $unit is still active; restarting it ($((n + 1)) of $MAX_RESTARTS)"
  revive+=("$unit")
done

# One transaction, so systemd orders the starts (a database before its
# clients, a namespace owner before its tenants). Not waited for: the next
# sweep sees how it went.
if [ "${#revive[@]}" -gt 0 ]; then
  systemctl restart --no-block -- "${revive[@]}" || echo "systemctl refused the restart of: ${revive[*]}"
fi
exit 0
