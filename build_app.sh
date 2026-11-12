#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

APP_NAME="WakeGPU"
APP_DIR="${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"

VERSION=$(sed -n 's/^const AppVersion = "\(.*\)"/\1/p' update.go)
if [ -z "$VERSION" ]; then
  VERSION="1.21.2"
fi

# Secreto de firma de licencias: por defecto usa clave comunitaria si no se define
WL_LICENSE_SECRET="${WL_LICENSE_SECRET:-wakegpu-community-2026-secret}"

echo "==> Building ${APP_NAME} v${VERSION} for macOS..."

# 1. Clean previous build
rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"

# 2. Generate AppIcon.icns if not present
if [ ! -f "AppIcon.icns" ] && [ -f "winres/icon.png" ]; then
  echo "==> Generating AppIcon.icns..."
  ICONSET="AppIcon.iconset"
  mkdir -p "${ICONSET}"
  for sz in 16 32 128 256 512; do
    sips -z $sz $sz "winres/icon.png" --out "${ICONSET}/icon_${sz}x${sz}.png" >/dev/null 2>&1
    double=$((sz * 2))
    sips -z $double $double "winres/icon.png" --out "${ICONSET}/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "${ICONSET}" -o "AppIcon.icns"
  rm -rf "${ICONSET}"
fi

if [ -f "AppIcon.icns" ]; then
  cp "AppIcon.icns" "${RESOURCES_DIR}/AppIcon.icns"
fi

# 3. Create Info.plist
cat > "${CONTENTS_DIR}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>es</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.wakegpu.desktop</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright © 2026 WakeGPU. Todos los derechos reservados.</string>
</dict>
</plist>
EOF

# 4. Create PkgInfo
echo -n "APPL????" > "${CONTENTS_DIR}/PkgInfo"

# 5. Compile Go binary with CGO
echo "==> Compiling native Go binary..."
go build -buildvcs=false -trimpath -ldflags "-s -w -X main.licenseSecret=${WL_LICENSE_SECRET}" -o "${MACOS_DIR}/${APP_NAME}" .

# 6. Codesign: Developer ID + notarización si hay credenciales, ad-hoc si no.
#    Para habilitar (requiere Apple Developer Program, $99/año):
#      export APPLE_DEVELOPER_ID="Developer ID Application: Nombre (TEAMID)"
#      export APPLE_TEAM_ID="TEAMID"
#      export APPLE_ID="tu@apple.com"
#      export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # de appleid.apple.com
#      ./build_app.sh
#    Sin esas variables el build sigue siendo ad-hoc (los usuarios verán el
#    aviso de Gatekeeper la primera vez; ver docs/DISTRIBUCION_MACOS.md).
SIGNED=0
if command -v codesign >/dev/null 2>&1; then
  if [ -n "${APPLE_DEVELOPER_ID:-}" ] && security find-identity -v -p codesigning 2>/dev/null | grep -q "${APPLE_DEVELOPER_ID}"; then
    echo "==> Signing with Developer ID (${APPLE_DEVELOPER_ID})..."
    codesign --force --deep --sign "${APPLE_DEVELOPER_ID}" --options runtime --timestamp \
      --entitlements Entitlements.plist "${APP_DIR}"
    SIGNED=1
    if command -v xcrun >/dev/null 2>&1 && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
      echo "==> Notarizing with notarytool..."
      ZIP_NOTARY="dist/${APP_NAME}-${VERSION}-notary.zip"
      mkdir -p dist
      ditto -c -k --keepParent "${APP_DIR}" "${ZIP_NOTARY}"
      xcrun notarytool submit "${ZIP_NOTARY}" \
        --apple-id "${APPLE_ID}" \
        --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
        --team-id "${APPLE_TEAM_ID}" \
        --wait
      xcrun stapler staple "${APP_DIR}"
      rm -f "${ZIP_NOTARY}"
      echo "==> Notarized and stapled."
    fi
  else
    echo "==> Applying ad-hoc codesign (no APPLE_DEVELOPER_ID set)..."
    codesign -s - --force --deep "${APP_DIR}"
  fi
fi

# 7. Package zip and manifest in dist/
mkdir -p dist
ZIP_NAME="${APP_NAME}-${VERSION}-macos.zip"
ZIP_PATH="dist/${ZIP_NAME}"
echo "==> Packaging ${ZIP_PATH}..."
rm -f "${ZIP_PATH}"
zip -r -q "${ZIP_PATH}" "${APP_DIR}"

SHA256=$(shasum -a 256 "${ZIP_PATH}" | cut -d' ' -f1)
SIZE=$(stat -f%z "${ZIP_PATH}")

cat > "dist/latest-macos.json" <<EOF
{
  "version": "${VERSION}",
  "url": "https://github.com/devexsolutions/wakegpu/releases/download/v${VERSION}/${ZIP_NAME}",
  "sha256": "${SHA256}",
  "size": ${SIZE},
  "notes": "Versión nativa de WakeGPU para macOS en español."
}
EOF

echo "==> Successfully created ${APP_DIR} and ${ZIP_PATH} (v${VERSION})"
echo "==> Manifest: dist/latest-macos.json"

