// licenseserver: servicio de licencias WakeGPU Pro para el lado vendedor.
//
// Emite claves WLPRO (mismo formato HMAC-SHA256 que la app), recibe webhooks de
// Lemon Squeezy, responde validación online (revocación) y ofrece un panel de
// administración para emisión manual y soporte. Ver docs/LICENCIAS.md.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/smtp"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var rawURLEnc = base64.RawURLEncoding

const graceDays = 7 // días de validez online que cubre cada revalidación

var (
	licenseSecret   = os.Getenv("WL_LICENSE_SECRET") // mismo valor que compila la app
	webhookSecret   = os.Getenv("LS_WEBHOOK_SECRET")
	adminToken      = os.Getenv("ADMIN_TOKEN")
	smtpHost        = os.Getenv("SMTP_HOST")
	smtpPort        = os.Getenv("SMTP_PORT")
	smtpUser        = os.Getenv("SMTP_USER")
	smtpPass        = os.Getenv("SMTP_PASS")
	smtpFrom        = os.Getenv("SMTP_FROM")
	dbPath          = envDefault("WL_DB_PATH", "licenses.json")
	listenAddr      = envDefault("WL_LISTEN_ADDR", ":8787")
	subscriptionTTL = 365 * 24 * time.Hour // suscripción anual
)

func envDefault(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// ---------- clave WLPRO (misma codificación que license.go de la app) ----------

type keyPayload struct {
	Email     string `json:"email"`
	Tier      string `json:"tier"`
	ExpiresAt int64  `json:"expires_at"`
	IssuedAt  int64  `json:"issued_at"`
}

func signKey(p keyPayload) (string, error) {
	if licenseSecret == "" {
		return "", errors.New("WL_LICENSE_SECRET no configurado")
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	b64 := rawURLEnc.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(licenseSecret))
	mac.Write([]byte(b64))
	sig := hex.EncodeToString(mac.Sum(nil))[:16]
	return "WLPRO-" + b64 + "-" + sig, nil
}

func parseKey(key string) (*keyPayload, error) {
	if licenseSecret == "" {
		return nil, errors.New("WL_LICENSE_SECRET no configurado")
	}
	key = strings.TrimSpace(key)
	parts := strings.Split(key, "-")
	if len(parts) != 3 || parts[0] != "WLPRO" {
		return nil, errors.New("formato inválido")
	}
	mac := hmac.New(sha256.New, []byte(licenseSecret))
	mac.Write([]byte(parts[1]))
	if !hmac.Equal([]byte(strings.ToLower(parts[2])), []byte(strings.ToLower(hex.EncodeToString(mac.Sum(nil))[:16]))) {
		return nil, errors.New("firma incorrecta")
	}
	raw, err := rawURLEnc.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("payload corrupto")
	}
	var p keyPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, errors.New("payload corrupto")
	}
	return &p, nil
}

// ---------- base de datos (JSON en disco, mismo patrón que libstore.go de la app) ----------

type LicenseRecord struct {
	Key       string `json:"key"`
	Email     string `json:"email"`
	Tier      string `json:"tier"`
	Source    string `json:"source"` // "lemonsqueezy" | "admin"
	OrderID   string `json:"order_id,omitempty"`
	IssuedAt  int64  `json:"issued_at"`
	ExpiresAt int64  `json:"expires_at"`
	Revoked   bool   `json:"revoked"`
	LastSeen  int64  `json:"last_seen,omitempty"`
}

type licenseDB struct {
	mu      sync.Mutex
	path    string
	Records []LicenseRecord `json:"records"`
}

func (db *licenseDB) load() {
	if b, err := os.ReadFile(db.path); err == nil {
		_ = json.Unmarshal(b, db)
	}
}

func (db *licenseDB) save() {
	b, _ := json.MarshalIndent(db, "", "  ")
	tmp := db.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Println("save db:", err)
		return
	}
	_ = os.Rename(tmp, db.path)
}

func (db *licenseDB) findByKey(key string) *LicenseRecord {
	for i := range db.Records {
		if db.Records[i].Key == key {
			return &db.Records[i]
		}
	}
	return nil
}

func (db *licenseDB) findByEmail(email string) *LicenseRecord {
	email = strings.TrimSpace(strings.ToLower(email))
	// la clave vigente más reciente gana
	var best *LicenseRecord
	for i := range db.Records {
		r := &db.Records[i]
		if r.Email != email {
			continue
		}
		if best == nil || r.IssuedAt > best.IssuedAt {
			best = r
		}
	}
	return best
}

// ---------- helpers HTTP ----------

func setCORS(w http.ResponseWriter) {
	origin := os.Getenv("WL_CORS_ORIGIN")
	if origin == "" {
		origin = "*"
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	setCORS(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST requerido"})
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return false
	}
	return true
}

// ---------- webhook Lemon Squeezy ----------

type lsWebhook struct {
	Meta struct {
		EventName string `json:"event_name"`
	} `json:"meta"`
	Data struct {
		ID         string `json:"id"`
		Attributes struct {
			UserEmail string `json:"user_email"`
			Status    string `json:"status"`
			Ident     string `json:"identifier"`
		} `json:"attributes"`
	} `json:"data"`
}

func handleWebhook(db *licenseDB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := readBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cuerpo ilegible"})
			return
		}
		if webhookSecret == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "webhook no configurado"})
			return
		}
		sig := r.Header.Get("X-Signature")
		mac := hmac.New(sha256.New, []byte(webhookSecret))
		mac.Write(body)
		if !hmac.Equal([]byte(strings.ToLower(sig)), []byte(hex.EncodeToString(mac.Sum(nil)))) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "firma inválida"})
			return
		}
		var ev lsWebhook
		if err := json.Unmarshal(body, &ev); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
			return
		}
		email := strings.TrimSpace(strings.ToLower(ev.Data.Attributes.UserEmail))
		if email == "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "falta email"})
			return
		}

		db.mu.Lock()
		ended := isEnded(ev.Data.Attributes.Status)
		switch {
		case ev.Meta.EventName == "subscription_expired" || ev.Meta.EventName == "subscription_cancelled" ||
			ev.Meta.EventName == "subscription_payment_failed" ||
			(ev.Meta.EventName == "subscription_updated" && ended):
			if rec := db.findByEmail(email); rec != nil {
				rec.Revoked = true
			}
			log.Println("webhook: revocada licencia de", email)
		case ev.Meta.EventName == "order_created" || ev.Meta.EventName == "subscription_created" ||
			ev.Meta.EventName == "subscription_payment_success" || ev.Meta.EventName == "subscription_updated":
			issueOrRenew(db, email, "lemonsqueezy", ev.Data.ID)
		default:
			db.mu.Unlock()
			log.Println("webhook: evento ignorado", ev.Meta.EventName)
			writeJSON(w, http.StatusOK, map[string]string{"ok": "ignorado"})
			return
		}
		db.save()
		db.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]string{"ok": "procesado"})
	}
}

func isEnded(status string) bool {
	switch status {
	case "cancelled", "expired", "unpaid", "on_trial_expired":
		return true
	}
	return false
}

// issueOrRenew crea la clave si no existe una vigente o la renueva +1 año.
func issueOrRenew(db *licenseDB, email, source, orderID string) {
	if rec := db.findByEmail(email); rec != nil && !rec.Revoked {
		rec.ExpiresAt = time.Now().Add(subscriptionTTL).Unix()
		if orderID != "" {
			rec.OrderID = orderID
		}
		rec.IssuedAt = time.Now().Unix()
		rec.LastSeen = 0
		log.Println("webhook: renovada licencia de", email)
		return
	}
	exp := time.Now().Add(subscriptionTTL)
	key, err := signKey(keyPayload{Email: email, Tier: "pro", ExpiresAt: exp.Unix(), IssuedAt: time.Now().Unix()})
	if err != nil {
		log.Println("webhook: error firmando clave:", err)
		return
	}
	db.Records = append(db.Records, LicenseRecord{
		Key: key, Email: email, Tier: "pro", Source: source, OrderID: orderID,
		IssuedAt: time.Now().Unix(), ExpiresAt: exp.Unix(),
	})
	sendKeyEmail(email, key)
	log.Println("webhook: emitida licencia para", email)
}

// ---------- validación online (la app llama aquí cada 24 h) ----------

type validateReq struct {
	Key string `json:"key"`
}

func handleValidate(db *licenseDB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req validateReq
		if !readJSON(w, r, &req) {
			return
		}
		payload, err := parseKey(req.Key)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"valid": false, "reason": "invalid"})
			return
		}
		db.mu.Lock()
		rec := db.findByKey(req.Key)
		now := time.Now().Unix()
		if rec != nil {
			rec.LastSeen = now
			db.save()
		}
		db.mu.Unlock()

		switch {
		case rec == nil:
			// clave firmada válida pero no registrada (p. ej. emitida a mano antes del server): válida mientras no expire
		case rec.Revoked:
			writeJSON(w, http.StatusOK, map[string]any{"valid": false, "revoked": true, "reason": "revoked"})
			return
		case rec.ExpiresAt > 0 && now > rec.ExpiresAt:
			writeJSON(w, http.StatusOK, map[string]any{"valid": false, "revoked": true, "reason": "expired"})
			return
		}
		if payload.ExpiresAt > 0 && now > payload.ExpiresAt {
			writeJSON(w, http.StatusOK, map[string]any{"valid": false, "revoked": true, "reason": "expired"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"valid":      true,
			"expires_at": payload.ExpiresAt,
			"tier":       payload.Tier,
		})
	}
}

// ---------- recuperación de clave por email ----------

type recoverReq struct {
	Email string `json:"email"`
}

type rateLimiter struct {
	mu sync.Mutex
	hits map[string][]time.Time
}

func (rl *rateLimiter) allow(ip string, max int, window time.Duration) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	kept := rl.hits[ip][:0]
	for _, t := range rl.hits[ip] {
		if now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	rl.hits[ip] = kept
	if len(kept) >= max {
		return false
	}
	rl.hits[ip] = append(kept, now)
	return true
}

func handleRecover(db *licenseDB, rl *rateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req recoverReq
		if !readJSON(w, r, &req) {
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		// respuesta genérica siempre: no revelar si el email existe
		writeJSON(w, http.StatusOK, map[string]string{"ok": "Si la dirección está registrada, recibirás un email en unos minutos."})
		if email == "" || !strings.Contains(email, "@") {
			return
		}
		ip, _, _ := strings.Cut(r.RemoteAddr, ":")
		if !rl.allow(ip, 5, time.Hour) {
			log.Println("recover: rate limit", ip)
			return
		}
		db.mu.Lock()
		rec := db.findByEmail(email)
		if rec != nil {
			rec.LastSeen = time.Now().Unix() // indicio de uso del portal
			db.save()
		}
		db.mu.Unlock()
		if rec != nil {
			sendKeyEmail(email, rec.Key)
		}
	}
}

// ---------- entrega inmediata post-checkout (claim por order_id + email) ----------

type claimReq struct {
	Email   string `json:"email"`
	OrderID string `json:"order_id"`
}

func handleClaim(db *licenseDB, rl *rateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req claimReq
		if !readJSON(w, r, &req) {
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		orderID := strings.TrimSpace(req.OrderID)
		if email == "" || orderID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email y order_id requeridos"})
			return
		}
		ip, _, _ := strings.Cut(r.RemoteAddr, ":")
		if !rl.allow("claim:"+ip, 15, time.Hour) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "demasiados intentos"})
			return
		}
		db.mu.Lock()
		rec := db.findByEmail(email)
		var matchedKey string
		if rec != nil && !rec.Revoked && rec.OrderID == orderID && time.Since(time.Unix(rec.IssuedAt, 0)) < 30*time.Minute {
			matchedKey = rec.Key
		}
		db.mu.Unlock()
		if matchedKey == "" {
			writeJSON(w, http.StatusAccepted, map[string]any{"ready": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ready": true,
			"key":   matchedKey,
			"email": email,
		})
	}
}

// ---------- administración ----------

type issueReq struct {
	Email string `json:"email"`
	Tier  string `json:"tier,omitempty"`
	Years int    `json:"years,omitempty"`
}

type revokeReq struct {
	Key string `json:"key"`
}

func adminAuth(r *http.Request) bool {
	if adminToken == "" {
		return false
	}
	tok := r.URL.Query().Get("token")
	if tok == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			tok = strings.TrimPrefix(h, "Bearer ")
		}
	}
	return hmac.Equal([]byte(tok), []byte(adminToken))
}

func handleAdminData(db *licenseDB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !adminAuth(r) {
			http.Error(w, "no autorizado", http.StatusUnauthorized)
			return
		}
		db.mu.Lock()
		out := make([]LicenseRecord, len(db.Records))
		copy(out, db.Records)
		db.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"records": out})
	}
}

func handleAdminIssue(db *licenseDB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !adminAuth(r) {
			http.Error(w, "no autorizado", http.StatusUnauthorized)
			return
		}
		var req issueReq
		if !readJSON(w, r, &req) {
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		if email == "" || !strings.Contains(email, "@") {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "email inválido"})
			return
		}
		years := req.Years
		if years <= 0 {
			years = 1
		}
		tier := req.Tier
		if tier == "" {
			tier = "pro"
		}
		exp := time.Now().Add(subscriptionTTL * time.Duration(years))
		key, err := signKey(keyPayload{Email: email, Tier: tier, ExpiresAt: exp.Unix(), IssuedAt: time.Now().Unix()})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		db.mu.Lock()
		db.Records = append(db.Records, LicenseRecord{
			Key: key, Email: email, Tier: tier, Source: "admin",
			IssuedAt: time.Now().Unix(), ExpiresAt: exp.Unix(),
		})
		db.save()
		db.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]string{"key": key})
	}
}

func handleAdminRevoke(db *licenseDB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !adminAuth(r) {
			http.Error(w, "no autorizado", http.StatusUnauthorized)
			return
		}
		var req revokeReq
		if !readJSON(w, r, &req) {
			return
		}
		db.mu.Lock()
		rec := db.findByKey(strings.TrimSpace(req.Key))
		if rec == nil {
			db.mu.Unlock()
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "clave no encontrada"})
			return
		}
		rec.Revoked = !rec.Revoked // alterna revocar/restaurar
		db.save()
		state := rec.Revoked
		db.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"revoked": state})
	}
}

func handleAdminPage(w http.ResponseWriter, r *http.Request) {
	if !adminAuth(r) {
		http.Error(w, "no autorizado", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(adminHTML))
}

// ---------- email ----------

func sendKeyEmail(to, key string) {
	if smtpHost == "" {
		log.Printf("[sin SMTP] clave para %s: %s", to, key)
		return
	}
	addr := smtpHost + ":" + smtpPortOr()
	subject := "Tu clave de WakeGPU Pro"
	body := "Gracias por comprar WakeGPU Pro.\n\nTu clave de licencia:\n" + key +
		"\n\nActívala en la app: Ajustes → Licencia y Plan → Activar clave.\nSi pierdes esta clave, recupérala en https://wakegpu.com/recover\n"
	msg := []byte("To: " + to + "\r\nSubject: " + subject + "\r\n\r\n" + body)
	var auth smtp.Auth
	if smtpUser != "" {
		auth = smtp.PlainAuth("", smtpUser, smtpPass, smtpHost)
	}
	if err := smtp.SendMail(addr, auth, smtpFromOr(), []string{to}, msg); err != nil {
		log.Println("email a", to, ":", err)
	}
}

func smtpPortOr() string {
	if smtpPort != "" {
		return smtpPort
	}
	return "587"
}

func smtpFromOr() string {
	if smtpFrom != "" {
		return smtpFrom
	}
	if smtpUser != "" {
		return smtpUser
	}
	return "licencias@wakegpu.com"
}

func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, errors.New("sin cuerpo")
	}
	return io.ReadAll(io.LimitReader(r.Body, 1<<20))
}

// ---------- página admin ----------

const adminHTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>WakeGPU · Licencias</title>
<style>
 body{font-family:system-ui,sans-serif;background:#141210;color:#e8e2d9;margin:0;padding:24px}
 h1{font-size:20px} table{border-collapse:collapse;width:100%;font-size:14px}
 th,td{padding:6px 10px;border-bottom:1px solid #333;text-align:left;word-break:break-all}
 th{color:#b5aca0;font-weight:600} .revoked{color:#e05b5b;text-decoration:line-through}
 form,section{background:#1d1a17;border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:16px}
 input,select,button{background:#26221e;color:inherit;border:1px solid #444;border-radius:6px;padding:6px 10px;margin-right:6px}
 button{cursor:pointer} .ok{color:#7ec97e} .err{color:#e05b5b} code{color:#9fc3e8}
</style></head><body>
<h1>Licencias WakeGPU Pro</h1>
<section><h2>Emitir manualmente</h2>
 <form id="fIssue">
  <input id="iEmail" type="email" placeholder="email del comprador" required>
  <select id="iTier"><option value="pro">pro</option><option value="studio">studio</option></select>
  <input id="iYears" type="number" value="1" min="1" max="5" style="width:60px"> años
  <button>Emitir</button><span id="issueMsg"></span>
 </form></section>
<section><h2>Claves emitidas</h2>
 <table id="tbl"><thead><tr><th>Email</th><th>Tier</th><th>Origen</th><th>Emitida</th><th>Expira</th><th>Últ. uso</th><th>Clave</th><th></th></tr></thead><tbody></tbody></table>
</section>
<script>
const TOKEN = new URLSearchParams(location.search).get("token");
const fdate = s => s ? new Date(s*1000).toLocaleDateString("es-ES") : "—";
async function load(){
 const r = await fetch("/admin/data?token="+TOKEN);
 const j = await r.json();
 const tb = document.querySelector("#tbl tbody");
 tb.innerHTML = "";
 (j.records||[]).sort((a,b)=>b.issued_at-a.issued_at).forEach(rec=>{
  const tr = document.createElement("tr");
  tr.innerHTML = "<td>"+rec.email+"</td><td>"+rec.tier+"</td><td>"+rec.source+"</td><td>"+fdate(rec.issued_at)+
   "</td><td>"+fdate(rec.expires_at)+"</td><td>"+fdate(rec.last_seen)+"</td><td class='"+(rec.revoked?"revoked":"")+"'><code>"+rec.key+"</code></td>"+
   "<td><button data-k='"+rec.key+"'>"+(rec.revoked?"Restaurar":"Revocar")+"</button></td>";
  tb.appendChild(tr);
 });
 tb.querySelectorAll("button").forEach(b=>b.onclick=async()=>{
  await fetch("/admin/revoke?token="+TOKEN,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:b.dataset.k})});
  load();
 });
}
document.querySelector("#fIssue").onsubmit = async e=>{
 e.preventDefault();
 const msg=document.querySelector("#issueMsg");
 const r=await fetch("/admin/issue?token="+TOKEN,{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({email:iEmail.value,tier:iTier.value,years:+iYears.value})});
 const j=await r.json();
 msg.className = j.key ? "ok" : "err";
 msg.textContent = j.key ? "Emitida: "+j.key : (j.error||"error");
 if(j.key) load();
};
load();
</script></body></html>`

// ---------- arranque ----------

func main() {
	log.SetFlags(log.LstdFlags)
	if licenseSecret == "" {
		log.Fatal("WL_LICENSE_SECRET no definido: es el mismo secreto con el que se compila la app")
	}
	if adminToken == "" {
		log.Println("aviso: ADMIN_TOKEN vacío: /admin quedará deshabilitado")
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil && !os.IsNotExist(err) {
		log.Println("aviso: no se pudo crear el dir de BD:", err)
	}
	db := &licenseDB{path: dbPath}
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
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"ok": "wakegpu-licenseserver"})
	})

	log.Println("licenseserver escuchando en", listenAddr, "| BD:", dbPath, "| webhook:", webhookSecret != "", "| SMTP:", smtpHost != "")
	if err := http.ListenAndServe(listenAddr, withCORS(mux)); err != nil {
		log.Fatal(err)
	}
}
