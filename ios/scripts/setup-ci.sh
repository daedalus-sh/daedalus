#!/bin/zsh
# One-time, on a Mac: push the App Store Connect API key to the engine repo's `testflight` environment
# and turn TestFlight deploys on. The same key anansi and lintel use works.
# Usage: ios/scripts/setup-ci.sh        (looks for ~/Downloads/AuthKey_*.p8 or AppStoreAPIKey_*.p8)
set -euo pipefail
setopt extended_glob
R=daedalus-sh/daedalus
E=testflight
D=~/Downloads

P8=( $D/(AuthKey|AppStoreAPIKey)_*.p8(N) ); P8=${P8[1]:-}
[[ -n "${P8:-}" ]] || { echo "No AuthKey_*.p8 in $D"; exit 1; }
KEY_ID=${${${P8:t:r}#AuthKey_}#AppStoreAPIKey_}            # the key ID is in the file name

read -r "ISSUER?Issuer ID (https://appstoreconnect.apple.com/access/integrations/api, top of the page): "
echo "key: ${P8:t}   key id: $KEY_ID   issuer: $ISSUER"

base64 -i $P8 | gh secret set ASC_KEY_P8_BASE64 --repo $R --env $E
gh secret set ASC_KEY_ID    --repo $R --env $E --body "$KEY_ID"
gh secret set ASC_ISSUER_ID --repo $R --env $E --body "$ISSUER"
gh variable set IOS_DEPLOY_ENABLED --repo $R --body true

echo "Done. The next push that touches ios/ ships a build: https://github.com/$R/actions/workflows/ios.yml"
