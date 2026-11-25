package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// Default secret for offline HMAC license validation. NOT stored in the repo:
// injected at build time via ldflags (-X main.licenseSecret=$WL_LICENSE_SECRET)
// or via the WL_LICENSE_SECRET env var for dev runs. See docs/LICENCIAS.md.
var licenseSecret = ""

func init() {
	if licenseSecret == "" {
		licenseSecret = os.Getenv("WL_LICENSE_SECRET")
	}
}

const (
	// defaultLicenseAPI is the license server used for online validation
	// (fresh installs). Existing configs stay offline unless the field is set.
	defaultLicenseAPI = "https://lic.wakegpu.com"
	// licenseGrace is how long a successful online check keeps Pro valid offline.
	licenseGrace = 7 * 24 * time.Hour
)

type LicensePayload struct {
	Email     string `json:"email"`
	Tier      string `json:"tier"`      // "pro" | "studio"
	ExpiresAt int64  `json:"expires_at"` // 0 = perpetual / lifetime
	IssuedAt  int64  `json:"issued_at"`
}

type PlanComparison struct {
	Feature string `json:"feature"`
	Free    string `json:"free"`
	Pro     string `json:"pro"`
}

type LicenseStatus struct {
	Tier         string           `json:"tier"` // "free" | "pro"
	IsPro        bool             `json:"is_pro"`
	Key          string           `json:"key"`
	Email        string           `json:"email"`
	ExpiresAt    int64            `json:"expires_at"`
	ExpiresText  string           `json:"expires_text"`
	VerifiedText string           `json:"verified_text"`
	PricingURL   string           `json:"pricing_url"`
	RecoverURL   string           `json:"recover_url"`
	ManageURL    string           `json:"manage_url"`
	Features     []string         `json:"features"`
	Comparison   []PlanComparison `json:"comparison"`
}

var defaultPlanComparison = []PlanComparison{
	{
		Feature: "Guardián Zero-Waste",
		Free:    "Apagado estándar Colab (30 min inactivo forzado)",
		Pro:     "Auto-apagado inmediato al vaciar la cola (ahorro de hasta 70% de CU)",
	},
	{
		Feature: "Agente de Código (Proxy OpenAI en VS Code)",
		Free:    "No disponible",
		Pro:     "Conexión ilimitada a Cline / Continue.dev con modelos Coder y total privacidad",
	},
	{
		Feature: "Generación por Lotes (Batch)",
		Free:    "1 tarea por envío (generación individual)",
		Pro:     "Hasta 50 variantes por lote con semillas aleatorias automáticas",
	},
	{
		Feature: "Pipelines Encadenados (Auto-HD)",
		Free:    "Manual (requiere esperar y pulsar botón HD en la cola)",
		Pro:     "Auto-HD encadenado automático (borrador ➔ HD sin esperas)",
	},
	{
		Feature: "Control desde el Móvil (iOS y Android PWA + QR)",
		Free:    "Solo uso en el escritorio",
		Pro:     "App Web Progresiva (PWA) con conexión por código QR en Wi-Fi o túnel 4G/5G",
	},
	{
		Feature: "Notificaciones Remotas en Móvil",
		Free:    "No disponible",
		Pro:     "Alertas push en Discord Webhook y Telegram Bot",
	},
	{
		Feature: "Sincronización Cloud y Respaldo",
		Free:    "Solo almacenamiento local",
		Pro:     "Copia de seguridad y Cloud Sync de prompts y plantillas en 1 clic",
	},
}

var proFeatures = []string{
	"zero_waste_watchdog",
	"coding_agent_proxy",
	"batch_generation",
	"chained_pipelines",
	"cloud_sync",
	"remote_notifications",
	"mobile_remote_pwa",
}

// GenerateLicenseKey creates a signed offline license key for a given email and expiration.
func GenerateLicenseKey(email, tier string, expiresAt time.Time) string {
	if tier == "" {
		tier = "pro"
	}
	var exp int64
	if !expiresAt.IsZero() {
		exp = expiresAt.Unix()
	}
	payload := LicensePayload{
		Email:     strings.TrimSpace(strings.ToLower(email)),
		Tier:      tier,
		ExpiresAt: exp,
		IssuedAt:  time.Now().Unix(),
	}
	raw, _ := json.Marshal(payload)
	b64Payload := base64.RawURLEncoding.EncodeToString(raw)

	mac := hmac.New(sha256.New, []byte(licenseSecret))
	mac.Write([]byte(b64Payload))
	sig := hex.EncodeToString(mac.Sum(nil))[:16] // 16-char hex prefix

	return "WLPRO-" + b64Payload + "-" + sig
}

// verifyLicenseKey checks the validity of a license key.
func verifyLicenseKey(key string) (*LicensePayload, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, errors.New("la clave de licencia no puede estar vacía")
	}

	// Dev / Trial bypass key for testing and demos
	if strings.EqualFold(key, "WLPRO-DEMO-2026") || strings.EqualFold(key, "WLPRO-TRIAL") {
		return &LicensePayload{
			Email:     "demo@wakegpu.com",
			Tier:      "pro",
			ExpiresAt: time.Now().Add(30 * 24 * time.Hour).Unix(),
			IssuedAt:  time.Now().Unix(),
		}, nil
	}

	parts := strings.Split(key, "-")
	if len(parts) != 3 || parts[0] != "WLPRO" {
		return nil, errors.New("formato de licencia inválido (debe comenzar con WLPRO-)")
	}

	b64Payload, providedSig := parts[1], parts[2]
	mac := hmac.New(sha256.New, []byte(licenseSecret))
	mac.Write([]byte(b64Payload))
	expectedSig := hex.EncodeToString(mac.Sum(nil))[:16]

	if !hmac.Equal([]byte(strings.ToLower(providedSig)), []byte(strings.ToLower(expectedSig))) {
		return nil, errors.New("clave de licencia no válida o firma incorrecta")
	}

	raw, err := base64.RawURLEncoding.DecodeString(b64Payload)
	if err != nil {
		return nil, errors.New("error al decodificar la carga de la licencia")
	}

	var payload LicensePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, errors.New("datos de licencia corruptos")
	}

	if payload.ExpiresAt > 0 && time.Now().Unix() > payload.ExpiresAt {
		return nil, errors.New("la licencia ha expirado")
	}

	return &payload, nil
}

// IsPro returns true if the current application configuration has a valid Pro license.
func IsPro() bool {
	c := getConfig()
	if c.LicenseTier != "pro" && c.LicenseTier != "studio" {
		return false
	}
	if c.LicenseKey == "" {
		return false
	}
	payload, err := verifyLicenseKey(c.LicenseKey)
	if err != nil {
		return false
	}
	if c.LicenseAPI != "" && c.LicenseValidUntil > 0 && time.Now().Unix() > c.LicenseValidUntil {
		return false // offline grace exhausted without a successful revalidation
	}
	return payload.Tier == "pro" || payload.Tier == "studio"
}

// getLicenseStatus returns the user-facing status of the current license.
func getLicenseStatus() LicenseStatus {
	c := getConfig()
	pro := IsPro()

	st := LicenseStatus{
		Tier:         "free",
		IsPro:        false,
		Key:          maskLicenseKey(c.LicenseKey),
		Email:        c.LicenseEmail,
		ExpiresAt:    c.LicenseExpires,
		ExpiresText:  "Sin licencia Pro activa (Plan Free)",
		PricingURL:   "https://wakegpu.com",
		RecoverURL:   "https://wakegpu.com",
		ManageURL:    "https://wakegpu.com",
		Features:     []string{},
		Comparison:   defaultPlanComparison,
	}

	if pro {
		st.IsPro = true
		st.Features = proFeatures
		if c.LicenseTier == "" || c.LicenseTier == "community" {
			st.Tier = "community"
			st.ExpiresText = "Comunidad Open Source · Todas las funciones Pro desbloqueadas"
			st.VerifiedText = "Versión de código abierto libre para la comunidad"
		} else {
			st.Tier = c.LicenseTier
			if c.LicenseExpires == 0 {
				st.ExpiresText = "Licencia Vitalicia (Lifetime)"
			} else {
				tm := time.Unix(c.LicenseExpires, 0)
				st.ExpiresText = "Válida hasta " + tm.Format("02/01/2006")
			}
		}
		if c.LicenseAPI != "" && c.LicenseTier != "" && c.LicenseTier != "community" {
			now := time.Now().Unix()
			if c.LicenseLastCheck == 0 {
				st.VerifiedText = "Pendiente de verificación online"
			} else if now <= c.LicenseValidUntil {
				validUntil := time.Unix(c.LicenseValidUntil, 0).Format("02/01/2006")
				st.VerifiedText = "Verificada online el " + time.Unix(c.LicenseLastCheck, 0).Format("02/01/2006") +
					" · válida sin conexión hasta " + validUntil
			}
		}
	}

	return st
}

// validateLicenseOnline checks the current Pro key against the license server.
// valid  -> extends the offline grace window (LicenseValidUntil).
// revoked/expired -> downgrades to Free (same cleanup as deactivation).
// no network -> keeps the current state; IsPro enforces the grace window.
func validateLicenseOnline() bool {
	c := getConfig()
	if c.LicenseAPI == "" || c.LicenseKey == "" || (c.LicenseTier != "pro" && c.LicenseTier != "studio") {
		return false
	}
	client := &http.Client{Timeout: 10 * time.Second}
	body, _ := json.Marshal(map[string]string{"key": c.LicenseKey})
	resp, err := client.Post(strings.TrimRight(c.LicenseAPI, "/")+"/api/validate", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Println("validación de licencia online no disponible:", err)
		return false
	}
	defer resp.Body.Close()

	var out struct {
		Valid bool   `json:"valid"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		log.Println("respuesta del servidor de licencias ilegible:", err)
		return false
	}

	if out.Valid {
		cfgMu.Lock()
		cfg.LicenseLastCheck = time.Now().Unix()
		cfg.LicenseValidUntil = time.Now().Add(licenseGrace).Unix()
		cc := cfg
		cfgMu.Unlock()
		saveConfig(cc)
		return true
	}

	log.Println("licencia", out.Reason, "según el servidor de licencias; volviendo al plan Free")
	cfgMu.Lock()
	cfg.LicenseKey = ""
	cfg.LicenseEmail = ""
	cfg.LicenseTier = "free"
	cfg.LicenseExpires = 0
	cfg.LicenseLastCheck = time.Now().Unix()
	cfg.LicenseValidUntil = 0
	cfg.ZeroWasteEnabled = false
	cc := cfg
	cfgMu.Unlock()
	saveConfig(cc)
	return false
}

// licenseValidationLoop revalidates the Pro license at startup and every 24 h.
func licenseValidationLoop() {
	validateLicenseOnline()
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for range t.C {
		validateLicenseOnline()
	}
}

func maskLicenseKey(key string) string {
	if len(key) <= 12 {
		return key
	}
	return key[:6] + "••••••••" + key[len(key)-4:]
}

// HTTP Handlers

func licenseGetHandler(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, http.StatusOK, getLicenseStatus())
}

type activateReq struct {
	Key   string `json:"key"`
	Email string `json:"email"`
}

func licenseActivateHandler(w http.ResponseWriter, r *http.Request) {
	var req activateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errOut(w, http.StatusBadRequest, errors.New("petición inválida"))
		return
	}

	payload, err := verifyLicenseKey(req.Key)
	if err != nil {
		errOut(w, http.StatusUnprocessableEntity, err)
		return
	}

	email := req.Email
	if email == "" {
		email = payload.Email
	}

	cfgMu.Lock()
	cfg.LicenseKey = req.Key
	cfg.LicenseEmail = email
	cfg.LicenseTier = payload.Tier
	cfg.LicenseExpires = payload.ExpiresAt
	// grant the offline grace window immediately; the first online check
	// (async below) confirms or the user keeps Pro for licenseGrace
	cfg.LicenseLastCheck = 0
	cfg.LicenseValidUntil = time.Now().Add(licenseGrace).Unix()
	c := cfg
	cfgMu.Unlock()
	saveConfig(c)
	go validateLicenseOnline() // best-effort first validation

	jsonOut(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "¡Licencia Pro activada con éxito!",
		"status":  getLicenseStatus(),
	})
}

func licenseDeactivateHandler(w http.ResponseWriter, r *http.Request) {
	cfgMu.Lock()
	cfg.LicenseKey = ""
	cfg.LicenseEmail = ""
	cfg.LicenseTier = "free"
	cfg.LicenseExpires = 0
	cfg.LicenseLastCheck = 0
	cfg.LicenseValidUntil = 0
	// If zero-waste was enabled, disable it when returning to Free tier
	cfg.ZeroWasteEnabled = false
	c := cfg
	cfgMu.Unlock()
	saveConfig(c)

	jsonOut(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "Licencia desactivada; ahora estás en el plan Free",
		"status":  getLicenseStatus(),
	})
}
