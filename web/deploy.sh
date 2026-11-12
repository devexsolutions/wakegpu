#!/usr/bin/env bash
# deploy.sh — Despliegue de la web estática de WakeGPU a VPS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
TARBALL="${SCRIPT_DIR}/wakegpu-web.tar.gz"

echo "================================================="
echo "  Preparando archivos web de WakeGPU para VPS"
echo "================================================="

# 1. Crear carpeta dist limpia con solo los archivos públicos a servir
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

cp "${SCRIPT_DIR}/index.html" "${DIST_DIR}/"
cp "${SCRIPT_DIR}/docs.html" "${DIST_DIR}/"
cp "${SCRIPT_DIR}/favicon.svg" "${DIST_DIR}/"
cp "${SCRIPT_DIR}/og-image.png" "${DIST_DIR}/"
cp "${SCRIPT_DIR}/og-image.jpg" "${DIST_DIR}/"
cp "${SCRIPT_DIR}/robots.txt" "${DIST_DIR}/"
cp "${SCRIPT_DIR}/sitemap.xml" "${DIST_DIR}/"

echo "✓ Archivos empaquetados en ${DIST_DIR}:"
ls -lh "${DIST_DIR}"

# 2. Generar archivo comprimido listo para transferir
cd "${DIST_DIR}"
tar -czf "${TARBALL}" *
cd "${SCRIPT_DIR}"

echo ""
echo "✓ Paquete comprimido listo: ${TARBALL} ($(du -h "${TARBALL}" | cut -f1))"
echo ""

# 3. Si se pasan argumentos, intentar despliegue directo por rsync/ssh
REMOTE="${1:-}"
REMOTE_PATH="${2:-/var/www/wakegpu/html}"

if [ -n "${REMOTE}" ]; then
  echo "Subiendo a ${REMOTE}:${REMOTE_PATH}..."
  ssh "${REMOTE}" "mkdir -p '${REMOTE_PATH}'"
  rsync -avz --delete "${DIST_DIR}/" "${REMOTE}:${REMOTE_PATH}/"
  echo ""
  echo "✅ ¡Despliegue completado con éxito en ${REMOTE}:${REMOTE_PATH}!"
else
  echo "Para subir los archivos a tu VPS, puedes elegir cualquiera de estas opciones:"
  echo ""
  echo "Opción A (Recomendada con rsync directo):"
  echo "  ./deploy.sh usuario@tu-vps.com /var/www/wakegpu/html"
  echo ""
  echo "Opción B (Subir con scp y descomprimir en el VPS):"
  echo "  scp ${TARBALL} usuario@tu-vps.com:/tmp/"
  echo "  ssh usuario@tu-vps.com 'mkdir -p /var/www/wakegpu/html && tar -xzf /tmp/wakegpu-web.tar.gz -C /var/www/wakegpu/html/'"
  echo ""
  echo "Opción C (Subir por SFTP o FileZilla):"
  echo "  Sube el contenido de la carpeta 'web/dist/' a tu directorio web del VPS (/var/www/wakegpu/html)."
  echo "================================================="
fi
