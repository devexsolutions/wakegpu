package main

import (
	"strings"
	"testing"
)

func TestMobileQRGeneration(t *testing.T) {
	url := "http://192.168.1.50:8080/?k=m_1234567890abcdef"
	svg := generateQRSVG(url)
	if svg == "" {
		t.Fatal("generateQRSVG devolvió cadena vacía")
	}
	if !strings.HasPrefix(svg, "<svg") || !strings.HasSuffix(svg, "</svg>") {
		t.Fatalf("SVG malformado: %s", svg[:30])
	}
	if !strings.Contains(svg, `viewBox="0 0`) || !strings.Contains(svg, `path fill="#000000"`) {
		t.Fatal("el SVG no contiene los atributos de dibujo esperados")
	}
}

func TestMobileServerLifecycleAndGating(t *testing.T) {
	withTempConfig(t, Config{LicenseTier: "free"})

	// En Free debe rechazar start
	_, err := startMobileServer(false)
	if err == nil {
		t.Fatal("startMobileServer debería fallar en plan Free")
	}

	// Con Pro debe arrancar y asignar puerto + token
	withTempConfig(t, Config{LicenseTier: "pro", LicenseKey: "WLPRO-DEMO-2026"})
	st, err := startMobileServer(false)
	if err != nil {
		t.Fatalf("error arrancando servidor móvil en Pro: %v", err)
	}
	if !st.Enabled || st.Port <= 0 || len(st.LANURLs) == 0 || st.PrimaryURL == "" {
		t.Fatalf("estado de móvil inválido: %+v", st)
	}
	if st.QRSVG == "" {
		t.Fatal("esperaba código QR SVG generado")
	}

	// Validación de token en API
	mobMu.Lock()
	tok := mobToken
	mobMu.Unlock()
	if !isValidAPIKey(tok) {
		t.Fatal("isValidAPIKey debería aceptar mobToken mientras esté activo")
	}
	if isValidAPIKey("bad-token") {
		t.Fatal("isValidAPIKey no debe aceptar tokens erróneos")
	}

	// Detener servidor
	stopped := stopMobileServer()
	if stopped.Enabled {
		t.Fatal("esperaba servidor móvil detenido")
	}
	if isValidAPIKey(tok) {
		t.Fatal("tras stopMobileServer el token ya no debe ser válido")
	}
}

