#!/bin/sh
# Injects window.__CG_INSTANCE__ into the statically served index.html /
# index_cgid.html at container start, declaring this instance's identity to
# the frontend (see src/common/instance.ts). Runs as an nginx
# /docker-entrypoint.d/ hook in the selfhost image.
#
# Configured via environment:
#   CG_APP_URL            required to activate, e.g. https://chat.example.org
#   CG_DEPLOYMENT         prod (default) | staging | dev
#   CG_CGID_URL           e.g. https://id.chat.example.org/#
#   CG_RECAPTCHA_SITE_KEY reCAPTCHA v2 site key; empty disables captcha
#   CG_ACTIVE_CHAINS      comma-separated chain keys this instance supports
#   CG_FEATURE_EMAIL      "true" if email delivery is configured
#   CG_FEATURE_TWITTER    "true" if Twitter/X auth is configured
#   CG_FEATURE_KYC        "true" if SumSub KYC is configured
#   CG_GIPHY_API_KEY      Giphy key; empty hides the GIF picker
#   CG_WALLETCONNECT_PROJECT_ID  WalletConnect Cloud project id
set -e

if [ -z "$CG_APP_URL" ]; then
  echo "inject-instance-config: CG_APP_URL not set, skipping injection"
  exit 0
fi

cfg="{\"deployment\":\"${CG_DEPLOYMENT:-prod}\",\"appUrl\":\"$CG_APP_URL\""
if [ -n "$CG_CGID_URL" ]; then
  cfg="$cfg,\"cgidUrl\":\"$CG_CGID_URL\""
fi
if [ -n "$CG_ACTIVE_CHAINS" ]; then
  chains_json=$(printf '%s' "$CG_ACTIVE_CHAINS" | awk -F, '{for(i=1;i<=NF;i++){gsub(/ /,"",$i); printf "%s\"%s\"", (i>1?",":""), $i}}')
  cfg="$cfg,\"activeChains\":[$chains_json]"
fi
bool() { [ "$1" = "true" ] && echo "true" || echo "false"; }
cfg="$cfg,\"features\":{\"email\":$(bool "$CG_FEATURE_EMAIL"),\"twitterAuth\":$(bool "$CG_FEATURE_TWITTER"),\"kyc\":$(bool "$CG_FEATURE_KYC")}"
cfg="$cfg,\"giphyApiKey\":\"$CG_GIPHY_API_KEY\""
if [ -n "$CG_WALLETCONNECT_PROJECT_ID" ]; then
  cfg="$cfg,\"walletConnectProjectId\":\"$CG_WALLETCONNECT_PROJECT_ID\""
fi
cfg="$cfg,\"recaptchaSiteKey\":\"$CG_RECAPTCHA_SITE_KEY\"}"
snippet="<script>window.__CG_INSTANCE__ = $cfg;</script>"

for f in /www/index.html /www/index_cgid.html; do
  if [ ! -f "$f" ]; then
    continue
  fi
  if grep -q '__CG_INSTANCE__' "$f"; then
    echo "inject-instance-config: $f already configured, skipping"
    continue
  fi
  sed -i "s|<head>|<head>$snippet|" "$f"
  echo "inject-instance-config: configured $f"
done
