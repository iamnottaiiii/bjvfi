FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       xvfb x11vnc novnc websockify openbox xdotool scrot dbus-x11 x11-xserver-utils wget ca-certificates \
  && wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/chrome.deb \
  && rm -f /tmp/chrome.deb \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
