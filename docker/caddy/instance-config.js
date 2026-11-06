{{- /*
Caddy template for /instance-config.js (served by the cg_instance_config
snippet in common.caddy). Declares this instance to the frontend as
window.__CG_INSTANCE__ (src/common/instance.ts validates every field; the
backend builds the same object for GET /api/v2/Instance/config in
srv/util/instanceConfig.ts — keep the rules in sync).

Configured via the container environment:
  CG_APP_URL            required to emit a config, e.g. https://chat.example.org;
                        unset (dev stack) = no config, the frontend falls back
                        to its built-in detection
  CG_DEPLOYMENT         prod (default) | staging | dev
  CG_LEGACY_CGID        "true" only on a legacy CG ID (gateway) instance:
                        emits cgidUrl, and no main-origin passkeys
  CG_CGID_URL           e.g. https://id.app.cg/# (legacy CG ID mode only)
  CG_PASSKEY_RP_ID      the backend's PASSKEY_RP_ID, if set (default: the host
                        of CG_APP_URL — must match the backend)
  CG_RECAPTCHA_SITE_KEY reCAPTCHA v2 site key (only used with reCAPTCHA)
  CG_CAPTCHA_PROVIDER   altcha (default) | recaptcha | off — only the initial
                        hint; GET /Captcha/config is the runtime authority
  CG_ACTIVE_CHAINS      comma-separated chain keys this instance supports
  CG_FEATURE_EMAIL      "true" if email delivery is configured
  CG_FEATURE_TWITTER    "true" if Twitter/X auth is configured
  CG_ENABLE_CALLS       "false" hides the call UI; anything else means on
  CG_ENABLE_IMAGE_FILTER "false" when the backend runs without the NSFW
                        image filter; skips the client-side pre-check too
  CG_IMAGE_FILTER_THRESHOLD  the backend's IMAGE_MODERATION_THRESHOLD
  CG_GIPHY_API_KEY      Giphy key; empty hides the GIF picker
  CG_WALLETCONNECT_PROJECT_ID  WalletConnect Cloud project id
  CG_GATEWAY_TARGET_URL  gateway sites only: origin of the instance it moved
                        to (emits gatewayTargetUrl)

A site that sets `vars cg_env_prefix GATEWAY_` (the gateway site of
Caddyfile.selfhost) reads every one of these as GATEWAY_CG_* instead, so one
Caddy can serve the instance config of the main instance and of the gateway.

Values only ever enter the output through toJson (Go's JSON encoder, which
also escapes <, > and &), never by pasting them into the script text.
*/ -}}
{{- /* a site can read another set of variables (the gateway's: GATEWAY_CG_*)
       by setting `vars cg_env_prefix <prefix>` (common.caddy) */ -}}
{{- $p := placeholder "http.vars.cg_env_prefix" -}}
{{- $appUrl := env (print $p "CG_APP_URL") -}}
{{- if not $appUrl -}}
// No instance configuration: CG_APP_URL is not set for this edge.
{{ else -}}
{{- $c := dict "deployment" (env (print $p "CG_DEPLOYMENT") | default "prod") "appUrl" $appUrl -}}
{{- /* same rules as srv/util/instanceConfig.ts: cgidUrl only in legacy CG
       ID mode, otherwise the RP ID of the main-origin passkeys */ -}}
{{- $passkeys := false -}}
{{- if eq (env (print $p "CG_LEGACY_CGID")) "true" -}}
  {{- with env (print $p "CG_CGID_URL") }}{{ $_ := set $c "cgidUrl" . }}{{ end -}}
{{- else -}}
  {{- $rpId := env (print $p "CG_PASSKEY_RP_ID") | default (regexReplaceAll "^[a-zA-Z]+://([^/:]+).*$" $appUrl "${1}") | lower -}}
  {{- if regexMatch "^[a-z0-9.-]{1,253}$" $rpId -}}
    {{- $_ := set $c "passkeyRpId" $rpId -}}
    {{- $passkeys = true -}}
  {{- end -}}
{{- end -}}
{{- with env (print $p "CG_ACTIVE_CHAINS") -}}
  {{- $chains := list -}}
  {{- range splitList "," . -}}
    {{- $chain := trim . -}}
    {{- if $chain }}{{ $chains = append $chains $chain }}{{ end -}}
  {{- end -}}
  {{- $_ := set $c "activeChains" $chains -}}
{{- end -}}
{{- /* calls and the image filter are opt-out: only an explicit "false"
       disables them, so an instance that never sets the variable keeps them */ -}}
{{- $_ := set $c "features" (dict
      "email" (eq (env (print $p "CG_FEATURE_EMAIL")) "true")
      "twitterAuth" (eq (env (print $p "CG_FEATURE_TWITTER")) "true")
      "calls" (ne (env (print $p "CG_ENABLE_CALLS")) "false")
      "imageFilter" (ne (env (print $p "CG_ENABLE_IMAGE_FILTER")) "false")
      "passkeys" $passkeys) -}}
{{- /* a number in the JSON, so only a numeric value is passed on; out-of-range
       values are left to the frontend, which falls back to the backend's
       default */ -}}
{{- with env (print $p "CG_IMAGE_FILTER_THRESHOLD") -}}
  {{- if regexMatch "^[0-9]*\\.?[0-9]+$" . }}{{ $_ := set $c "imageFilterThreshold" (float64 .) }}{{ end -}}
{{- end -}}
{{- /* gateway sites only: the instance this one moved to (an http(s) origin) */ -}}
{{- with env (print $p "CG_GATEWAY_TARGET_URL") -}}
  {{- if regexMatch "^https?://[^/?#[:space:]]+$" . }}{{ $_ := set $c "gatewayTargetUrl" . }}{{ end -}}
{{- end -}}
{{- $_ := set $c "giphyApiKey" (env (print $p "CG_GIPHY_API_KEY")) -}}
{{- with env (print $p "CG_WALLETCONNECT_PROJECT_ID") }}{{ $_ := set $c "walletConnectProjectId" . }}{{ end -}}
{{- $_ := set $c "recaptchaSiteKey" (env (print $p "CG_RECAPTCHA_SITE_KEY")) -}}
{{- $_ := set $c "captchaProvider" (env (print $p "CG_CAPTCHA_PROVIDER") | default "altcha") -}}
window.__CG_INSTANCE__ = {{ toJson $c }};
{{ end -}}
