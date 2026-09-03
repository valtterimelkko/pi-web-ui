#!/usr/bin/env bash
# Alert-only probe for the real authenticated Internal API health route.
set -uo pipefail

CURL_BIN="${PI_WEB_UI_HEALTH_CURL:-/usr/bin/curl}"
LOGGER_BIN="${PI_WEB_UI_HEALTH_LOGGER:-/usr/bin/logger}"
NOTIFY_BIN="${PI_WEB_UI_HEALTH_NOTIFY:-/root/pi-web-ui/scripts/notify.sh}"
SOCKET_PATH="${PI_WEB_UI_INTERNAL_API_SOCKET:-/root/.pi-web-ui/internal-api.sock}"
TOKEN_PATH="${PI_WEB_UI_INTERNAL_API_TOKEN_PATH:-/root/.pi-web-ui/internal-api-token}"
STATE_FILE="${PI_WEB_UI_HEALTH_STATE_FILE:-/run/pi-web-ui-health-probe.failures}"

healthy=false
if [[ -S "$SOCKET_PATH" && -r "$TOKEN_PATH" ]]; then
  token="$(<"$TOKEN_PATH")"
  response="$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    "$CURL_BIN" --config - --silent --show-error --fail --max-time 5 \
      --unix-socket "$SOCKET_PATH" http://localhost/api/v1/health 2>/dev/null)" || response=""
  if printf '%s' "$response" | /usr/bin/node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(input);
        process.exit(value.status === "ok" && typeof value.contract?.contractVersion === "string" ? 0 : 1);
      } catch { process.exit(1); }
    });
  '; then
    healthy=true
  fi
fi

if $healthy; then
  rm -f "$STATE_FILE"
  exit 0
fi

failures=0
[[ -r "$STATE_FILE" ]] && read -r failures < "$STATE_FILE"
[[ "$failures" =~ ^[0-9]+$ ]] || failures=0
failures=$((failures + 1))
printf '%s\n' "$failures" > "$STATE_FILE"

if (( failures == 3 || (failures > 3 && failures % 15 == 0) )); then
  message="event=health_probe_failed consecutive_failures=$failures socket=$SOCKET_PATH auto_restart=false"
  "$LOGGER_BIN" -p daemon.warning -t pi-web-ui-health-probe "$message" || true
  "$NOTIFY_BIN" blocked "Pi Web UI health probe failed" "$message" || true
fi
exit 1
