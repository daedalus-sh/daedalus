# What the rebuilding verbs ask of Grafana: a Prometheus query through its
# datasource proxy (image-update's health check), and a silence over the
# alerts a planned restart sets off (the quiet window). Inlined by mkAgent
# after host/lib.sh.
#
# Expects, from daedalus-lib.nix's grafanaVars, all three or none:
#   GRAFANA_HOST  the published hostname   GRAFANA_ADDR  the LAN address it is dialled at
#   GRAFANA_ENV   the dotenv holding Grafana's break-glass login
# With the monitoring module off they are unset and every function here
# returns non-zero; callers treat that as "nothing to ask", never as a failure.
#
# One door, Grafana's HTTPS route, rather than `podman exec` into prometheus:
# the same path the operator's own debugging uses, real TLS, and the login
# goes to curl on stdin (`-K -`), so it is never on a command line.

grafana_ready() {
  [ -n "${GRAFANA_HOST-}" ] && [ -n "${GRAFANA_ADDR-}" ] && [ -r "${GRAFANA_ENV-}" ]
}

# grafana_api METHOD PATH [JSON-BODY] — the response body on stdout.
grafana_api() {
  grafana_ready || return 1
  local method="$1" path="$2" body="${3-}" user pass
  user="$(grep -m1 '^GF_SECURITY_ADMIN_USER=' "$GRAFANA_ENV" | cut -d= -f2-)"
  pass="$(grep -m1 '^GF_SECURITY_ADMIN_PASSWORD=' "$GRAFANA_ENV" | cut -d= -f2-)"
  local args=(-fsS --max-time 10 --resolve "$GRAFANA_HOST:443:$GRAFANA_ADDR" -X "$method" -K -)
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  # curl's config syntax: a double-quoted value, with \ and " escaped.
  printf 'user = "%s"\n' "$(printf '%s' "$user:$pass" | sed 's/[\\"]/\\&/g')" |
    curl "${args[@]}" "https://$GRAFANA_HOST$path"
}

# prom_query EXPR — Prometheus's instant-query JSON on stdout.
prom_query() {
  local q
  q="$(jq -rn --arg q "$1" '$q | @uri')"
  grafana_api GET "/api/datasources/proxy/uid/prometheus-default/api/v1/query?query=$q"
}

# --- the quiet window ------------------------------------------------------
#
# A switch restarts containers on purpose, and each restart is briefly every
# symptom these rules watch for: a container gone, a target unscraped, a probe
# failing, a burst of 5xx through traefik, a unit failed on its first try. So
# before a verb switches it opens a silence over exactly those rules, and when
# the verb's unit stops — however it stopped — its reaper (host/update-reaper.sh)
# cuts the silence down to QUIET_TAIL minutes from then.
#
# Nothing broken is hidden for long. The silence only defers notification:
# whatever is still firing when it ends is mailed then. The tail is 12 minutes
# because the 5xx rule sums the last 10 minutes, so a burst during the switch
# stays in its window that long after the switch is over. A silence that is
# never closed (the box died mid-run) still expires on its own: QUIET_OPEN
# minutes after it began.
#
# Critical rules about the box itself (ZFS, disk, memory, temperature, the
# object store, the VPN) are never in the list: no restart explains them.

QUIET_ALERTS='Container Disappeared|Scrape Target Down|Web App Probe Failing|Traefik 5xx Spike|Host Systemd Service Failed|Minecraft Not Answering|Log Shipping Stalled'
QUIET_OPEN=45
QUIET_TAIL=12
QUIET_DIR=/run/daedalus-quiet

# quiet_silence ID MINUTES COMMENT — create (ID empty) or replace a silence
# ending MINUTES from now; its id on stdout.
quiet_silence() {
  local body
  body="$(jq -nc --arg id "$1" --arg re "$QUIET_ALERTS" --arg c "$3" \
    --arg s "$(date -u +%FT%TZ)" --arg e "$(date -u -d "+$2 min" +%FT%TZ)" '
    { matchers: [{ name: "alertname", value: $re, isRegex: true, isEqual: true }],
      startsAt: $s, endsAt: $e, createdBy: "daedalus", comment: $c }
    + (if $id == "" then {} else { id: $id } end)')"
  grafana_api POST /api/alertmanager/grafana/api/v2/silences "$body" | jq -re '.silenceID'
}

# quiet_begin KEY COMMENT [MINUTES] — open the window for verb KEY. Never fails
# the caller: a box without Grafana, or a Grafana that is down, just pages.
quiet_begin() {
  local key="$1" comment="$2" minutes="${3:-$QUIET_OPEN}" id
  grafana_ready || return 0
  if id="$(quiet_silence "" "$minutes" "$comment" 2>/dev/null)"; then
    install -d -m 0700 "$QUIET_DIR"
    printf '%s\t%s\n' "$id" "$comment" >"$QUIET_DIR/$key"
  else
    echo "could not open a quiet window in Grafana; this run's restarts may page" >&2
  fi
  return 0
}

# quiet_end KEY — cut verb KEY's window to QUIET_TAIL minutes from now.
quiet_end() {
  local f="$QUIET_DIR/$1" id comment
  [ -f "$f" ] || return 0
  IFS=$'\t' read -r id comment <"$f" || true
  rm -f -- "$f"
  [ -n "${id-}" ] || return 0
  quiet_silence "$id" "$QUIET_TAIL" "${comment-}" >/dev/null 2>&1 ||
    echo "could not shorten quiet window $id; it expires on its own" >&2
  return 0
}
