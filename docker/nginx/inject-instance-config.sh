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
#   CG_RECAPTCHA_SITE_KEY reCAPTCHA v2 site key (only used when the provider is reCAPTCHA)
#   CG_CAPTCHA_PROVIDER   altcha (default) | recaptcha | off; auto-detected from
#                         CG_RECAPTCHA_SITE_KEY when unset
#   CG_ACTIVE_CHAINS      comma-separated chain keys this instance supports
#   CG_FEATURE_EMAIL      "true" if email delivery is configured
#   CG_FEATURE_TWITTER    "true" if Twitter/X auth is configured
#   CG_ENABLE_CALLS       "false" hides the call UI (mediasoup not deployed);
#                         anything else (incl. unset) means calls are on
#   CG_ENABLE_IMAGE_FILTER "false" when the backend runs without the NSFW
#                         image filter; skips the client-side pre-check too
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
# opt-out flag: only an explicit "false" disables the feature, so an instance
# that never sets the variable keeps calls
optout() { [ "$1" = "false" ] && echo "false" || echo "true"; }
cfg="$cfg,\"features\":{\"email\":$(bool "$CG_FEATURE_EMAIL"),\"twitterAuth\":$(bool "$CG_FEATURE_TWITTER"),\"calls\":$(optout "${CG_ENABLE_CALLS:-}"),\"imageFilter\":$(optout "${CG_ENABLE_IMAGE_FILTER:-}")}"
cfg="$cfg,\"giphyApiKey\":\"$CG_GIPHY_API_KEY\""
if [ -n "$CG_WALLETCONNECT_PROJECT_ID" ]; then
  cfg="$cfg,\"walletConnectProjectId\":\"$CG_WALLETCONNECT_PROJECT_ID\""
fi
cfg="$cfg,\"recaptchaSiteKey\":\"$CG_RECAPTCHA_SITE_KEY\""
# The backend (GET /Captcha/config) is the runtime authority for the captcha
# provider; this injected value is only the initial hint. Default to the
# fail-closed ALTCHA so a site key alone never flips the hint away from what an
# unconfigured backend resolves.
captcha_provider="${CG_CAPTCHA_PROVIDER:-altcha}"
cfg="$cfg,\"captchaProvider\":\"$captcha_provider\"}"
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
