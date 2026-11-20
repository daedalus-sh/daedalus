# shellcheck shell=bash
# Mints the key pair the control plane signs its Grafana embed tokens with,
# once; a later run changes nothing. Rotate by deleting DIR and rebuilding,
# then restart grafana and the control plane.
#
# Parameters: DIR (the key's home under machineState), OWNER, GROUP.
#   $DIR/env          GRAFANA_EMBED_KEY=<the private key, PKCS#8 DER, base64>
#   $DIR/pub/key.pem  the public half, the one file Grafana mounts
install -d -m 0700 -o "$OWNER" -g "$GROUP" "$(dirname "$DIR")" "$DIR" "$DIR/pub"
if [ ! -s "$DIR/env" ] || [ ! -s "$DIR/pub/key.pem" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  openssl genpkey -algorithm ed25519 -out "$tmp/key.pem"
  openssl pkey -in "$tmp/key.pem" -pubout -out "$tmp/pub.pem"
  printf 'GRAFANA_EMBED_KEY=%s\n' "$(openssl pkey -in "$tmp/key.pem" -outform DER | base64 -w0)" >"$tmp/env"
  install -m 0600 -o "$OWNER" -g "$GROUP" "$tmp/pub.pem" "$DIR/pub/key.pem"
  install -m 0600 -o "$OWNER" -g "$GROUP" "$tmp/env" "$DIR/env"
fi
