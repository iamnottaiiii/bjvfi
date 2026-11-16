#!/bin/bash
# Starts the remote browser inside the Codespace:
# Xvfb (virtual screen) + Chrome + x11vnc + noVNC web client on port 6080.
# Writes the one-click link to LINK.txt and prints it.
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
export DISPLAY=:99
mkdir -p "$BASE/logs" "$BASE/profile" "$BASE/.vnc" "$BASE/home"

if [ ! -f "$BASE/.vnc/passwd" ]; then
  PW=$(tr -dc 'a-z0-9' < /dev/urandom | head -c 10)
  x11vnc -storepasswd "$PW" "$BASE/.vnc/passwd" >/dev/null 2>&1
  echo "$PW" > "$BASE/vnc-pass.txt"
  chmod 600 "$BASE/vnc-pass.txt" "$BASE/.vnc/passwd"
fi
PW=$(cat "$BASE/vnc-pass.txt")

if ! pgrep -f "Xvfb :99" >/dev/null; then
  Xvfb :99 -screen 0 1280x800x24 >>"$BASE/logs/xvfb.log" 2>&1 &
  sleep 1
fi
if ! pgrep -x openbox >/dev/null 2>&1; then
  openbox >>"$BASE/logs/openbox.log" 2>&1 &
  sleep 1
fi
if ! pgrep -f "remote-browser.*profile|user-data-dir=$BASE/profile" >/dev/null; then
  google-chrome \
    --user-data-dir="$BASE/profile" \
    --no-first-run --no-default-browser-check \
    --disable-dev-shm-usage --disable-gpu --no-sandbox \
    --start-maximized --window-size=1280,800 \
    --hide-crash-restore-bubble \
    --homepage="https://duckduckgo.com" \
    about:blank >>"$BASE/logs/chrome.log" 2>&1 &
  sleep 2
fi
if ! pgrep -f "x11vnc.*:99" >/dev/null; then
  x11vnc -display :99 -rfbauth "$BASE/.vnc/passwd" -rfbport 5900 \
    -forever -shared -noxdamage >>"$BASE/logs/x11vnc.log" 2>&1 &
  sleep 1
fi
if ! pgrep -f "websockify.*6080" >/dev/null; then
  websockify --web /usr/share/novnc 6080 localhost:5900 >>"$BASE/logs/websockify.log" 2>&1 &
  sleep 1
fi

if [ -n "${CODESPACE_NAME:-}" ]; then
  LINK="https://${CODESPACE_NAME}-6080.app.github.dev/vnc.html?autoconnect=true&resize=remote&password=${PW}"
else
  LINK="Port 6080 forwarded URL + /vnc.html?autoconnect=true&resize=remote&password=${PW}"
fi
echo "$LINK" > "$BASE/LINK.txt"
echo ""
echo "==================================================="
echo "YOUR REMOTE BROWSER LINK:"
echo "$LINK"
echo "==================================================="
echo ""
