# Sistema de Licencias WakeGPU y Modelo Open Source

Este documento explica cómo funciona el modelo de licencias de **WakeGPU**:
- **Edición Comunitaria (Open Source MIT)**: Todas las funcionalidades avanzadas (Guardián Zero-Waste, generación por lotes, Auto-HD, Proxy local OpenAI para IDEs y control remoto PWA) vienen **desbloqueadas de serie al 100% de forma gratuita**.
- **Infraestructura de licencias opcional (`licenseserver/`)**: Se preserva el backend de validación HMAC-SHA256 (`licenseserver/main.go`) para despliegues empresariales privados o acuerdos comerciales dedicados.

---

## 1. Arquitectura de licencias

1. **Web oficial (`web/index.html`)**:
   - Muestra las ventajas de WakeGPU en **Español** e **Inglés**.
   - Proporciona descargas directas para macOS (Apple Silicon e Intel) y Windows x64.
2. **Servidor de licencias (`licenseserver/main.go`)**:
   - Genera y firma criptográficamente claves `WLPRO-<payload_base64url>-<hmac_16hex>` usando `WL_LICENSE_SECRET`.
   - Ofrece endpoints para validación (`POST /api/validate`), reclamación (`POST /api/claim`), recuperación (`POST /api/recover`) y panel de control (`GET /admin`).
3. **Aplicación de escritorio (`license.go`)**:
   - Reconoce por defecto la edición comunitaria libre (`c.LicenseTier == "" || c.LicenseTier == "community"` -> `IsPro() = true`).
   - Verifica firmas HMAC-SHA256 en caso de claves comerciales personalizadas.

---

## 2. Configuración de Lemon Squeezy (desde España)

1. Crea tu cuenta en [lemonsqueezy.com](https://www.lemonsqueezy.com/) y configura tu cuenta bancaria española (IBAN) o PayPal en **Settings → Payouts**.
2. En **Store → Products**, crea un producto llamado **Wakeloom Pro** (suscripción anual, p. ej. `49 €/año`).
3. Copia el enlace de compra (*Share → Checkout Link*) y ponlo en los botones `.lemonsqueezy-button` de `web/index.html` añadiendo `?embed=1` al final (ej.: `https://wakeloom.lemonsqueezy.com/buy/TU_ID?embed=1`).
4. En **Settings → Webhooks**, añade un webhook:
   - **Callback URL**: `https://lic.wakeloom.com/webhook/lemonsqueezy`
   - **Signing Secret**: genera una cadena secreta aleatoria (será tu `LS_WEBHOOK_SECRET`).
   - **Eventos a marcar**:
     - `order_created`
     - `subscription_created`
     - `subscription_updated`
     - `subscription_payment_success`
     - `subscription_payment_failed`
     - `subscription_cancelled`
     - `subscription_expired`

---

## 3. Despliegue de `licenseserver`

Compila y ejecuta el servidor de licencias en tu VPS:

```bash
cd licenseserver
go build -buildvcs=false -o wakeloom-licenseserver .
```

Variables de entorno necesarias:

| Variable | Descripción |
|---|---|
| `WL_LICENSE_SECRET` | Secreto HMAC-SHA256 compartido con el binario de la app (`build_app.sh`). |
| `LS_WEBHOOK_SECRET` | *Signing Secret* configurado en el webhook de Lemon Squeezy. |
| `ADMIN_TOKEN` | Token para acceder al panel `https://lic.wakeloom.com/admin?token=...`. |
| `WL_DB_PATH` | Ruta del archivo JSON de base de datos (por defecto `licenses.json`). |
| `WL_LISTEN_ADDR` | Dirección de escucha (por defecto `:8787`). |
| `WL_CORS_ORIGIN` | Origen permitido para CORS desde la web (por defecto `*`, recomendable `https://wakeloom.com`). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Configuración SMTP para enviar las claves por email. |

---

## 4. Compilación de la app con el secreto de producción

Al compilar la aplicación macOS o Windows para distribución, inyecta el mismo `WL_LICENSE_SECRET`:

```bash
export WL_LICENSE_SECRET="tu-secreto-hmac-de-produccion"
./build_app.sh
```

