package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testSecret = "test-license-secret-xyz"

func init() {
	licenseSecret = testSecret
	adminToken = "test-admin-token"
	webhookSecret = "test-webhook-secret"
}

type memServer struct {
	URL     string
	handler http.Handler
}

func (m *memServer) Close() {}

var activeMemHandler http.Handler

func newTestServer(t *testing.T) (*memServer, *licenseDB) {
	t.Helper()
	db := &licenseDB{path: filepath.Join(t.TempDir(), "licenses.json")}
	db.load()
	rl := &rateLimiter{hits: map[string][]time.Time{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /webhook/lemonsqueezy", handleWebhook(db))
	mux.HandleFunc("POST /api/validate", handleValidate(db))
	mux.HandleFunc("POST /api/recover", handleRecover(db, rl))
	mux.HandleFunc("POST /api/claim", handleClaim(db, rl))
	mux.HandleFunc("GET /admin", handleAdminPage)
	mux.HandleFunc("GET /admin/data", handleAdminData(db))
	mux.HandleFunc("POST /admin/issue", handleAdminIssue(db))
	mux.HandleFunc("POST /admin/revoke", handleAdminRevoke(db))
	h := withCORS(mux)
	activeMemHandler = h
	return &memServer{URL: "http://mem.local", handler: h}, db
}

func doMemRequest(t *testing.T, method, url, body string, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:12345"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	activeMemHandler.ServeHTTP(rec, req)
	resp := rec.Result()
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func postJSON(t *testing.T, url, body string, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	return doMemRequest(t, http.MethodPost, url, body, headers)
}

func lsSignature(body string) string {
	mac := hmac.New(sha256.New, []byte(webhookSecret))
	mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}

func lsEvent(event, email string) string {
	b, _ := json.Marshal(map[string]any{
		"meta": map[string]any{"event_name": event},
		"data": map[string]any{
			"id": "order-123",
			"attributes": map[string]any{
				"user_email": email,
				"status":     "active",
			},
		},
	})
	return string(b)
}

// ---------- claves ----------

func TestSignAndParseKey(t *testing.T) {
	exp := time.Now().Add(subscriptionTTL)
	key, err := signKey(keyPayload{Email: "a@b.com", Tier: "pro", ExpiresAt: exp.Unix(), IssuedAt: time.Now().Unix()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, "WLPRO-") {
		t.Fatalf("clave sin prefijo: %s", key)
	}
	p, err := parseKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if p.Email != "a@b.com" || p.Tier != "pro" {
		t.Fatalf("payload inesperado: %+v", p)
	}
	// una clave alterada no verifica
	if _, err := parseKey(key[:len(key)-2] + "zz"); err == nil {
		t.Fatal("una clave manipulada debería rechazarse")
	}
}

// ---------- webhook ----------

func TestWebhookIssueAndRevoke(t *testing.T) {
	srv, db := newTestServer(t)
	defer srv.Close()

	resp, out := postJSON(t, srv.URL+"/webhook/lemonsqueezy", lsEvent("order_created", "buyer@example.com"),
		map[string]string{"X-Signature": lsSignature(lsEvent("order_created", "buyer@example.com"))})
	if resp.StatusCode != 200 || out["ok"] != "procesado" {
		t.Fatalf("webhook issue: %d %v", resp.StatusCode, out)
	}
	rec := db.findByEmail("buyer@example.com")
	if rec == nil || rec.Revoked {
		t.Fatal("no se emitió la licencia")
	}
	if rec.ExpiresAt <= time.Now().Unix() {
		t.Fatal("la licencia emitida ya está caducada")
	}

	// reemisión (renovación) no duplica
	postJSON(t, srv.URL+"/webhook/lemonsqueezy", lsEvent("subscription_payment_success", "buyer@example.com"),
		map[string]string{"X-Signature": lsSignature(lsEvent("subscription_payment_success", "buyer@example.com"))})
	if len(db.Records) != 1 {
		t.Fatalf("esperaba 1 registro, hay %d", len(db.Records))
	}

	// cancelación revoca
	postJSON(t, srv.URL+"/webhook/lemonsqueezy", lsEvent("subscription_cancelled", "buyer@example.com"),
		map[string]string{"X-Signature": lsSignature(lsEvent("subscription_cancelled", "buyer@example.com"))})
	if !db.findByEmail("buyer@example.com").Revoked {
		t.Fatal("la cancelación no revocó la licencia")
	}
}

func TestWebhookBadSignature(t *testing.T) {
	srv, db := newTestServer(t)
	defer srv.Close()
	resp, _ := postJSON(t, srv.URL+"/webhook/lemonsqueezy", lsEvent("order_created", "x@y.com"),
		map[string]string{"X-Signature": "deadbeef"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("firma inválida aceptada: %d", resp.StatusCode)
	}
	if len(db.Records) != 0 {
		t.Fatal("se emitió una licencia con firma inválida")
	}
}

// ---------- validate ----------

func TestValidateIssueRevokeRestore(t *testing.T) {
	srv, db := newTestServer(t)
	defer srv.Close()

	key, _ := signKey(keyPayload{Email: "v@example.com", Tier: "pro", ExpiresAt: time.Now().Add(time.Hour).Unix(), IssuedAt: time.Now().Unix()})
	db.Records = append(db.Records, LicenseRecord{Key: key, Email: "v@example.com", Tier: "pro", IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()})

	// 1. clave vigente: válida
	resp, out := postJSON(t, srv.URL+"/api/validate", `{"key":"`+key+`"}`, nil)
	if resp.StatusCode != 200 || out["valid"] != true {
		t.Fatalf("validate vigente: %v", out)
	}
	// 2. revocada: inválida
	db.mu.Lock()
	db.Records[0].Revoked = true
	db.save()
	db.mu.Unlock()
	_, out = postJSON(t, srv.URL+"/api/validate", `{"key":"`+key+`"}`, nil)
	if out["valid"] != false || out["reason"] != "revoked" {
		t.Fatalf("validate revocada: %v", out)
	}
	// 3. restaurada: válida de nuevo
	db.mu.Lock()
	db.Records[0].Revoked = false
	db.save()
	db.mu.Unlock()
	_, out = postJSON(t, srv.URL+"/api/validate", `{"key":"`+key+`"}`, nil)
	if out["valid"] != true {
		t.Fatalf("validate restaurada: %v", out)
	}
	// 4. clave falsificada: inválida
	_, out = postJSON(t, srv.URL+"/api/validate", `{"key":"WLPRO-fake-fake"}`, nil)
	if out["valid"] != false {
		t.Fatalf("validate clave falsa: %v", out)
	}
}

// ---------- recover ----------

func TestRecoverGenericAndRateLimit(t *testing.T) {
	srv, db := newTestServer(t)
	defer srv.Close()

	key, _ := signKey(keyPayload{Email: "r@example.com", Tier: "pro", ExpiresAt: time.Now().Add(time.Hour).Unix(), IssuedAt: time.Now().Unix()})
	db.Records = append(db.Records, LicenseRecord{Key: key, Email: "r@example.com", Tier: "pro", IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()})

	// respuesta genérica exista o no el email (anti-enumeración)
	resp, out := postJSON(t, srv.URL+"/api/recover", `{"email":"r@example.com"}`, nil)
	if resp.StatusCode != 200 || out["ok"] == "" {
		t.Fatalf("recover existente: %d %v", resp.StatusCode, out)
	}
	resp, _ = postJSON(t, srv.URL+"/api/recover", `{"email":"desconocido@example.com"}`, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("recover inexistente debe ser 200 genérico, fue %d", resp.StatusCode)
	}
	// rate limit: 5 por hora por IP; la 6ª no debe disparar envío (no visible aquí, pero la 6ª sigue 200 genérica)
	for i := 0; i < 6; i++ {
		postJSON(t, srv.URL+"/api/recover", `{"email":"r@example.com"}`, nil)
	}
	// sin pánico y sin persistir más registros
	if len(db.Records) != 1 {
		t.Fatalf("recover no debe crear registros: %d", len(db.Records))
	}
}

// ---------- admin ----------

func TestAdminFlow(t *testing.T) {
	srv, db := newTestServer(t)
	defer srv.Close()
	tok := "?token=" + adminToken

	// sin token: 401
	resp, _ := postJSON(t, srv.URL+"/admin/issue", `{"email":"m@n.com"}`, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("admin sin token: %d", resp.StatusCode)
	}

	// emisión manual
	resp, out := postJSON(t, srv.URL+"/admin/issue"+tok, `{"email":"Manual@Example.com","years":2}`, nil)
	if resp.StatusCode != 200 || out["key"] == nil {
		t.Fatalf("admin issue: %d %v", resp.StatusCode, out)
	}
	key := out["key"].(string)
	p, err := parseKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if p.Email != "manual@example.com" || p.Tier != "pro" {
		t.Fatalf("payload manual: %+v", p)
	}
	// años: 2 años > 1 año de margen
	if p.ExpiresAt < time.Now().Add(subscriptionTTL+time.Hour).Unix() {
		t.Fatal("la clave manual de 2 años expira demasiado pronto")
	}
	if len(db.Records) != 1 || db.Records[0].Source != "admin" {
		t.Fatalf("registro manual: %+v", db.Records)
	}

	// revocar y restaurar
	resp, out = postJSON(t, srv.URL+"/admin/revoke"+tok, `{"key":"`+key+`"}`, nil)
	if resp.StatusCode != 200 || out["revoked"] != true {
		t.Fatalf("admin revoke: %d %v", resp.StatusCode, out)
	}
	_, out = postJSON(t, srv.URL+"/api/validate", `{"key":"`+key+`"}`, nil)
	if out["valid"] != false {
		t.Fatal("clave revocada sigue válida")
	}
	resp, out = postJSON(t, srv.URL+"/admin/revoke"+tok, `{"key":"`+key+`"}`, nil)
	if resp.StatusCode != 200 || out["revoked"] != false {
		t.Fatalf("admin restore: %d %v", resp.StatusCode, out)
	}

	// datos del panel
	_, data := doMemRequest(t, http.MethodGet, srv.URL+"/admin/data"+tok, "", nil)
	recs := data["records"].([]any)
	if len(recs) != 1 {
		t.Fatalf("admin/data: %d registros", len(recs))
	}
}

func TestDBPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "licenses.json")
	db1 := &licenseDB{path: path}
	db1.load()
	db1.Records = append(db1.Records, LicenseRecord{Key: "k", Email: "e@x.com", IssuedAt: 1})
	db1.save()
	db2 := &licenseDB{path: path}
	db2.load()
	if len(db2.Records) != 1 || db2.Records[0].Email != "e@x.com" {
		t.Fatalf("persistencia falló: %+v", db2.Records)
	}
	// el fichero no debe ser legible por todos
	info, _ := os.Stat(path)
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("permisos de BD demasiado amplios: %v", info.Mode())
	}
}

func TestCORSAndPostCheckoutClaim(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	// 1. Preflight OPTIONS debe devolver 204 y cabeceras CORS
	resp, _ := doMemRequest(t, http.MethodOptions, srv.URL+"/api/recover", "", nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("esperaba 204 en OPTIONS, obtuve %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") == "" {
		t.Fatal("falta cabecera Access-Control-Allow-Origin en OPTIONS")
	}

	// 2. Antes del webhook, claim devuelve 202 ready=false
	cResp, cOut := postJSON(t, srv.URL+"/api/claim", `{"email":"checkout@example.com","order_id":"order-123"}`, nil)
	if cResp.StatusCode != http.StatusAccepted || cOut["ready"] != false {
		t.Fatalf("claim previo al webhook inesperado: %d %v", cResp.StatusCode, cOut)
	}

	// 3. Llega el webhook de Lemon Squeezy
	ev := lsEvent("order_created", "checkout@example.com")
	postJSON(t, srv.URL+"/webhook/lemonsqueezy", ev, map[string]string{"X-Signature": lsSignature(ev)})

	// 4. Con order_id incorrecto no entrega la clave
	_, badOut := postJSON(t, srv.URL+"/api/claim", `{"email":"checkout@example.com","order_id":"order-999"}`, nil)
	if badOut["ready"] != false {
		t.Fatalf("claim con order_id erróneo no debe entregar clave: %v", badOut)
	}

	// 5. Con order_id + email correctos entrega la clave inmediatamente
	okResp, okOut := postJSON(t, srv.URL+"/api/claim", `{"email":"checkout@example.com","order_id":"order-123"}`, nil)
	if okResp.StatusCode != http.StatusOK || okOut["ready"] != true {
		t.Fatalf("claim válido falló: %d %v", okResp.StatusCode, okOut)
	}
	key, _ := okOut["key"].(string)
	if !strings.HasPrefix(key, "WLPRO-") {
		t.Fatalf("clave devuelta inválida: %q", key)
	}
}
