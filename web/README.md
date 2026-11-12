# Web de WakeGPU (Landing & Documentación ES / EN)

Páginas estáticas bilingües (Español / Inglés) sin dependencias de compilación listas para producción:
- `index.html`: Landing completa con propuesta de valor, comparativa de ahorro de costes frente a SaaS de créditos, guía paso a paso, integración con n8n/FFmpeg para canales Faceless y enlaces directos de descarga para macOS y Windows.
- `docs.html`: Documentación completa de usuario (requisitos, instalación en macOS y Windows, conexión con Google Colab en Modo Local y Pasarela VPS, uso de cada pestaña, Guardián Zero-Waste, proxy local para Cursor/VS Code y solución de problemas).
- `favicon.svg`: Isotipo vectorial optimizado para navegadores.
- `og-image.png`: Imagen para Open Graph / Twitter Cards en alta resolución (1200x630).
- `robots.txt` y `sitemap.xml`: Indexación para motores de búsqueda optimizada para `wakegpu.com`.
- `nginx.wakegpu.conf`: Plantilla de configuración lista para Nginx en VPS con SSL Let's Encrypt, compresión gzip y cabeceras de seguridad.
- `Caddyfile`: Plantilla alternativa lista para Caddy (SSL automático).
- `deploy.sh`: Script de empaquetado y subida directa por SSH/rsync a tu VPS.

## Despliegue en VPS (wakegpu.com)

### Opción 1: Despliegue directo con `deploy.sh`
```bash
cd web
./deploy.sh usuario@tu-vps.com /var/www/wakegpu/html
```

### Opción 2: Subir archivo comprimido `wakegpu-web.tar.gz`
```bash
# Subir al VPS
scp web/wakegpu-web.tar.gz usuario@tu-vps.com:/tmp/

# En el VPS
ssh usuario@tu-vps.com
sudo mkdir -p /var/www/wakegpu/html
sudo tar -xzf /tmp/wakegpu-web.tar.gz -C /var/www/wakegpu/html/
sudo chown -R www-data:www-data /var/www/wakegpu/html
```

### Opción 3: Subida manual (SFTP / FileZilla / cPanel)
Sube directamente el contenido de la carpeta `web/dist/` a tu directorio público del VPS (ej: `/var/www/wakegpu/html`).

---

## Configuración del servidor web (Nginx)

Copia `nginx.wakegpu.conf` a `/etc/nginx/sites-available/wakegpu`:
```bash
sudo cp nginx.wakegpu.conf /etc/nginx/sites-available/wakegpu
sudo ln -s /etc/nginx/sites-available/wakegpu /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```
Obtén certificados SSL gratuitos:
```bash
sudo certbot --nginx -d wakegpu.com -d www.wakegpu.com
```
