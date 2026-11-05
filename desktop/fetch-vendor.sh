#!/usr/bin/env bash
# Downloads ADB (Android platform-tools) and scrcpy-server for bundling.
# Usage: ./fetch-vendor.sh win|linux
set -euo pipefail
cd "$(dirname "$0")"
OS="${1:?win or linux}"
SCRCPY=3.3.4
# Same hash as scrcpy's own install_release.sh for this version.
SCRCPY_SHA256=8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e
mkdir -p vendor/"$OS"
curl -fsSL -o vendor/scrcpy-server "https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY}/scrcpy-server-v${SCRCPY}"
echo "$SCRCPY_SHA256  vendor/scrcpy-server" | sha256sum --check
if [ "$OS" = win ]; then PT=windows; else PT=linux; fi
curl -fsSL -o /tmp/pt.zip "https://dl.google.com/android/repository/platform-tools-latest-${PT}.zip"
rm -rf /tmp/pt && mkdir -p /tmp/pt && (cd /tmp/pt && unzip -q /tmp/pt.zip)
if [ "$OS" = win ]; then
  cp /tmp/pt/platform-tools/{adb.exe,AdbWinApi.dll,AdbWinUsbApi.dll,NOTICE.txt} vendor/win/
else
  cp /tmp/pt/platform-tools/{adb,NOTICE.txt} vendor/linux/
  chmod +x vendor/linux/adb
fi
ls -la vendor vendor/"$OS"
