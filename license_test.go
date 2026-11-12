package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func init() {
	// los tests firman con un secreto explícito; nunca el de producción
	if licenseSecret == "" {
		licenseSecret = "unit-test-license-secret"
	}
}

func TestLicenseVerification(t *testing.T) {
	// 1. Demo key
	p, err := verifyLicenseKey("WLPRO-DEMO-2026")
	if err != nil || p.Tier != "pro" {
		t.Fatalf("expected demo key to succeed, got %v, %v", p, err)
	}

	// 2. Generated valid key (lifetime)
	validKey := GenerateLicenseKey("artist@example.com", "pro", time.Time{})
	p2, err := verifyLicenseKey(validKey)
	if err != nil {
		t.Fatalf("expected valid key to pass, got error: %v", err)
	}
	if p2.Email != "artist@example.com" || p2.Tier != "pro" || p2.ExpiresAt != 0 {
		t.Fatalf("unexpected payload: %+v", p2)
	}

	// 3. Generated valid key with future expiration
	future := time.Now().Add(365 * 24 * time.Hour)
	futureKey := GenerateLicenseKey("client@studio.com", "studio", future)
	p3, err := verifyLicenseKey(futureKey)
	if err != nil || p3.Tier != "studio" {
		t.Fatalf("expected studio key to pass, got %v, %v", p3, err)
	}

	// 4. Expired key
	past := time.Now().Add(-24 * time.Hour)
	expiredKey := GenerateLicenseKey("old@example.com", "pro", past)
	_, err = verifyLicenseKey(expiredKey)
	if err == nil {
		t.Fatal("expected expired key to fail verification")
	}

	// 5. Tampered key
	tampered := validKey[:len(validKey)-3] + "abc"
	_, err = verifyLicenseKey(tampered)
	if err == nil {
		t.Fatal("expected tampered key to fail verification")
	}

	// 6. Invalid format
	_, err = verifyLicenseKey("INVALID-KEY-FORMAT")
	if err == nil {
		t.Fatal("expected invalid format to fail")
	}

	// 7. LicenseStatus comparison metadata
	st := getLicenseStatus()
	if st.PricingURL == "" {
		t.Errorf("expected PricingURL in LicenseStatus")
	}
	if len(st.Comparison) == 0 {
		t.Errorf("expected Comparison entries in LicenseStatus")
	}
}

// ---- validación online con gracia offline ----

func withLicenseConfig(t *testing.T, mutate func(c *Config)) {
	t.Helper()
	cfgMu.Lock()
	old := cfg
	cfg = Config{JobTimeoutMin: 30, DraftScale: 0.5, LicenseAPI: ""}
	mutate(&cfg)
	t.Cleanup(func() {
		cfgMu.Lock()
		cfg = old
		cfgMu.Unlock()
	})
	cfgMu.Unlock()
}

func TestIsProGraceWindow(t *testing.T) {
	key := GenerateLicenseKey("grace@example.com", "pro", time.Now().Add(365*24*time.Hour))

	// sin LicenseAPI: modo offline clásico, la clave sola basta
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier, c.LicenseExpires = key, "pro", time.Now().Add(365*24*time.Hour).Unix()
	})
	if !IsPro() {
		t.Fatal("modo offline: clave válida debería ser Pro")
	}

	// con LicenseAPI y gracia vigente: Pro
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier = key, "pro"
		c.LicenseAPI = "https://lic.example.com"
		c.LicenseValidUntil = time.Now().Add(24 * time.Hour).Unix()
	})
	if !IsPro() {
		t.Fatal("gracia vigente: debería ser Pro")
	}

	// con LicenseAPI y gracia agotada sin revalidar: Free
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier = key, "pro"
		c.LicenseAPI = "https://lic.example.com"
		c.LicenseValidUntil = time.Now().Add(-time.Hour).Unix()
	})
	if IsPro() {
		t.Fatal("gracia agotada: debería volver a Free")
	}

	// con LicenseAPI pero sin primera verificación (ValidUntil=0): sigue Pro
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier = key, "pro"
		c.LicenseAPI = "https://lic.example.com"
		c.LicenseValidUntil = 0
	})
	if !IsPro() {
		t.Fatal("sin primera verificación online no debería perder Pro")
	}
}

func TestValidateLicenseOnline(t *testing.T) {
	key := GenerateLicenseKey("online@example.com", "pro", time.Now().Add(365*24*time.Hour))

	// servidor que acepta la clave
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/validate" {
			http.NotFound(w, r)
			return
		}
		var req struct{ Key string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		valid := req.Key == key
		reason := ""
		if !valid {
			reason = "revoked"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"valid": valid, "reason": reason})
	}))
	defer okSrv.Close()

	// 1. validación con éxito: extiende la ventana de gracia
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier = key, "pro"
		c.LicenseAPI = okSrv.URL
	})
	if !validateLicenseOnline() {
		t.Fatal("validación online debería triunfar")
	}
	cfgMu.RLock()
	lastCheck, validUntil := cfg.LicenseLastCheck, cfg.LicenseValidUntil
	cfgMu.RUnlock()
	if lastCheck == 0 || validUntil < time.Now().Add(licenseGrace-time.Hour).Unix() {
		t.Fatalf("gracia no extendida: last=%d until=%d", lastCheck, validUntil)
	}

	// 2. clave revocada en el servidor: baja a Free
	revokedKey := GenerateLicenseKey("revoked@example.com", "pro", time.Now().Add(365*24*time.Hour))
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier = revokedKey, "pro"
		c.LicenseAPI = okSrv.URL // este servidor solo acepta `key`, no revokedKey
	})
	if validateLicenseOnline() {
		t.Fatal("clave revocada no debería validar")
	}
	if IsPro() {
		t.Fatal("tras revocación online la app debería estar en Free")
	}

	// 3. servidor inalcanzable: se conserva el estado (sin downgrades por caída)
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier = key, "pro"
		c.LicenseAPI = "http://127.0.0.1:1" // puerto cerrado
		c.LicenseValidUntil = time.Now().Add(24 * time.Hour).Unix()
	})
	if validateLicenseOnline() {
		t.Fatal("servidor caído no debería contar como validación")
	}
	if !IsPro() {
		t.Fatal("caída del servidor no debería quitar Pro dentro de la gracia")
	}

	// 4. LicenseAPI vacía: la validación online no hace nada
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier = key, "pro"
		c.LicenseAPI = ""
	})
	if validateLicenseOnline() {
		t.Fatal("sin LicenseAPI no debería intentar validar")
	}
}

func TestLicenseStatusURLs(t *testing.T) {
	key := GenerateLicenseKey("urls@example.com", "pro", time.Time{})
	withLicenseConfig(t, func(c *Config) {
		c.LicenseKey, c.LicenseTier, c.LicenseEmail = key, "pro", "urls@example.com"
	})
	st := getLicenseStatus()
	if !st.IsPro {
		t.Fatal("esperaba Pro")
	}
	for _, u := range []string{st.PricingURL, st.RecoverURL, st.ManageURL} {
		if !strings.HasPrefix(u, "https://") {
			t.Fatalf("URL de usuario inválida: %q", u)
		}
	}
	if st.VerifiedText != "" {
		t.Fatalf("sin LicenseAPI no debería haber texto de verificación: %q", st.VerifiedText)
	}
}

