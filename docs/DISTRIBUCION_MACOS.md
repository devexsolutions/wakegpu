# Distribución de WakeGPU en macOS

Estado: canal actual **GitHub Releases** con codesign **ad-hoc** (sin cuenta de
Apple Developer). Este documento describe cómo instalar la app hoy y cómo
activar la firma + notarización cuando haya cuenta de Developer Program.

## Canal actual (sin cuenta de Developer)

- El zip se publica en GitHub Releases; el auto-actualizador apunta a
  `dist/latest-macos.json` (generado por `build_app.sh`).
- El codesign es ad-hoc (`codesign -s -`), por lo que **macOS muestra el aviso
  de Gatekeeper** la primera vez que un usuario abre la app descargada. Esto es
  inevitable sin firma Developer ID: el atributo de cuarentena lo añade el
  navegador al descargar, no el zip.

### Instrucciones para el usuario (primera apertura)

1. Descargar `WakeGPU-<versión>-macos.zip` desde Releases y descomprimirlo.
2. Arrastrar `WakeGPU.app` a `/Applications`.
3. Abrir la app con **clic derecho → Abrir** (no doble clic). En el diálogo que
   aparece, pulsar **Abrir** de nuevo. Solo se pide la primera vez.
4. Si aparece "WakeGPU.app está dañado" (ocurre con algunas descargas de
   Safari), ejecutar en Terminal:
   `xattr -cr /Applications/WakeGPU.app`

### Canal alternativo sin aviso: Homebrew

Homebrew **no aplica el atributo de cuarentena** al instalar un cask, así que
`brew install --cask` abre la app sin ningún aviso de Gatekeeper aunque la
firma sea ad-hoc. Es el canal sin fricción disponible hoy sin pagar los $99.

Para montarlo se necesita un repo público `homebrew-tap` con un cask como:

```ruby
cask "wakegpu" do
  version "1.21.3"
  sha256 "SHA256_DEL_ZIP"

  url "https://github.com/devexsolutions/wakegpu/releases/download/v#{version}/WakeGPU-#{version}-macos.zip"
  name "WakeGPU"
  desc "Despierta GPUs de Google Colab bajo demanda y ahorra Compute Units"
  homepage "https://wakegpu.com"

  app "WakeGPU.app"
  zap trash: "~/Library/Application Support/WakeGPU"
end
```

El SHA256 que genera `build_app.sh` en `dist/latest-macos.json` es el mismo que
debe llevar el cask. Los usuarios instalan con:
`brew install --cask a3974892-cmd/tap/wakegpu` (una vez creado el repo
`homebrew-tap` con `Casks/wakegpu.rb`).

## Cuando haya cuenta de Apple Developer ($99/año)

Con Developer ID + notarización, la app descargada **abre sin ningún aviso** y
sin instrucciones especiales. El build ya está preparado; solo hace falta:

1. Alta en el Apple Developer Program y crear un certificado
   *Developer ID Application* (en Xcode o Keychain).
2. Generar una contraseña específica de app en <https://appleid.apple.com>.
3. Compilar con las credenciales:

```bash
export APPLE_DEVELOPER_ID="Developer ID Application: <Nombre> (<TEAMID>)"
export APPLE_TEAM_ID="<TEAMID>"
export APPLE_ID="tu@apple.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
./build_app.sh
```

El script firmará con Hardened Runtime (`Entitlements.plist` incluido), enviará
a notarización con `notarytool --wait`, y dejará el ticket pegado
(`stapler staple`) antes de empaquetar el zip. No hay que cambiar nada más:
mismo zip, mismo canal de Releases, sin avisos para el usuario.

## Notas

- La vía de la **App Store** requeriría además App Sandbox, eliminar el
  auto-actualizador (guideline 2.7) y las claves privadas de WebKit usadas en
  `window_darwin.go` (guideline 2.5.2). Ver conversación de mantenimiento;
  de momento no es el canal elegido.
- El binario tiene `LSMinimumSystemVersion` 11.0; compilar en una máquina más
  nueva es válido, pero probar siempre el zip en una macOS limpia antes de
  publicar el Release.
