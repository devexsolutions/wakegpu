package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed ui
var uiFS embed.FS

var apiKey = func() string { b := make([]byte, 16); rand.Read(b); return hex.EncodeToString(b) }()

func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func errOut(w http.ResponseWriter, code int, err error) {
	jsonOut(w, code, map[string]string{"error": err.Error()})
}

func newServer() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(uiFS, "ui")
	fileSrv := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if qk := r.URL.Query().Get("k"); isValidAPIKey(qk) {
			http.SetCookie(w, &http.Cookie{
				Name:     "wl_mob",
				Value:    qk,
				Path:     "/",
				MaxAge:   30 * 24 * 3600,
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
			})
		}
		fileSrv.ServeHTTP(w, r)
	})

	api := http.NewServeMux()
	api.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		c := getConfig()
		if c.CFClientSecret != "" {
			c.CFClientSecret = "********"
		}
		if c.HFToken != "" {
			c.HFToken = "********"
		}
		if c.NotifyTelegramToken != "" {
			c.NotifyTelegramToken = "********"
		}
		llms := make([]LLMProvider, len(c.LLMs))
		for i, p := range c.LLMs {
			if p.APIKey != "" {
				p.APIKey = keyMask
			}
			llms[i] = p
		}
		c.LLMs = llms
		jsonOut(w, 200, map[string]any{"config": c, "data_dir": dataDir, "version": AppVersion, "default_update_url": defaultUpdateURL})
	})
	api.HandleFunc("POST /api/config", func(w http.ResponseWriter, r *http.Request) {
		var c Config
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			errOut(w, 400, err)
			return
		}
		old := getConfig()
		if c.CFClientSecret == "********" {
			c.CFClientSecret = old.CFClientSecret
		}
		if c.HFToken == "********" {
			c.HFToken = old.HFToken
		}
		if c.NotifyTelegramToken == "********" {
			c.NotifyTelegramToken = old.NotifyTelegramToken
		}
		// the settings form does not carry the guide's state or license keys
		c.Onboarded = old.Onboarded || c.Onboarded
		c.OnboardStep, c.Checklist, c.ChecklistHidden, c.CURates = old.OnboardStep, old.Checklist, old.ChecklistHidden, old.CURates
		c.LicenseKey, c.LicenseEmail, c.LicenseTier, c.LicenseExpires = old.LicenseKey, old.LicenseEmail, old.LicenseTier, old.LicenseExpires
		c.Language = strings.TrimSpace(strings.ToLower(c.Language))
		if c.Language != "en" && c.Language != "zh" && c.Language != "es" {
			c.Language = old.Language
			if c.Language == "" {
				c.Language = "es"
			}
		}
		if !IsPro() {
			c.ZeroWasteEnabled = false
			c.NotifyDiscordURL = ""
			c.NotifyTelegramToken = ""
			c.NotifyTelegramChat = ""
		}
		c.HFToken = strings.TrimSpace(c.HFToken)
		for i, p := range c.LLMs {
			if p.ID == "" {
				c.LLMs[i].ID = newID()
			}
			if p.APIKey == keyMask {
				c.LLMs[i].APIKey = ""
				for _, q := range old.LLMs {
					if q.ID == p.ID {
						c.LLMs[i].APIKey = q.APIKey
					}
				}
			}
		}
		if c.OutDir == "" {
			c.OutDir = defaultOutDir()
		}
		if err := saveConfig(c); err != nil {
			errOut(w, 500, err)
			return
		}
		store.poke()
		jsonOut(w, 200, map[string]bool{"ok": true})
	})

	// ---- gate passthrough ----
	gatePass := func(method, path string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var in any
			if method == "POST" {
				b, _ := io.ReadAll(r.Body)
				if len(b) > 0 {
					json.Unmarshal(b, &in)
				}
			}
			var out any
			if err := gateJSON(method, path, in, &out); err != nil {
				code := 502
				if ge, ok := err.(*GateError); ok && ge.Status >= 400 {
					code = ge.Status
				}
				jsonOut(w, code, map[string]any{"error": err.Error(), "status": code})
				return
			}
			if method == "POST" {
				autoStopped = false
				store.poke()
			}
			jsonOut(w, 200, out)
		}
	}
	api.HandleFunc("GET /api/gate/status", gatePass("GET", "/_gate/status"))
	api.HandleFunc("POST /api/gate/test", func(w http.ResponseWriter, r *http.Request) {
		st, err := testGateway(15 * time.Second)
		if err != nil {
			errOut(w, 502, err)
			return
		}
		markChecklist("login")
		jsonOut(w, 200, st)
	})
	api.HandleFunc("GET /api/gate/profiles", gatePass("GET", "/_gate/profiles"))
	wakePass := gatePass("POST", "/_gate/wake")
	api.HandleFunc("POST /api/gate/wake", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var in struct {
			Profile string `json:"profile"`
		}
		json.Unmarshal(b, &in)
		if why := customWakeProblem(in.Profile); why != "" { // a broken custom profile would only burn CU
			jsonOut(w, 400, map[string]any{"error": why, "status": 400})
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(b))
		rec := &statusRecorder{ResponseWriter: w, code: 200}
		wakePass(rec, r)
		if rec.code < 300 {
			markChecklist("wake")
		}
	})
	api.HandleFunc("POST /api/gate/stop", func(w http.ResponseWriter, r *http.Request) {
		warn := ud.beforeStop() // back up ComfyUI user data first (at most 20 s)
		var out map[string]any
		if err := gateJSON("POST", "/_gate/stop", map[string]any{}, &out); err != nil {
			code := 502
			if ge, ok := err.(*GateError); ok && ge.Status >= 400 {
				code = ge.Status
			}
			jsonOut(w, code, map[string]any{"error": err.Error(), "status": code, "backup_warning": warn})
			return
		}
		if out == nil {
			out = map[string]any{}
		}
		out["backup_warning"] = warn
		markChecklist("stop")
		store.poke()
		jsonOut(w, 200, out)
	})
	api.HandleFunc("POST /api/gate/extend", gatePass("POST", "/_gate/extend"))
	api.HandleFunc("POST /api/gate/switch", gatePass("POST", "/_gate/switch"))
	api.HandleFunc("GET /api/gate/events", sseProxy)
	api.HandleFunc("GET /api/gate/library", gatePass("GET", "/_gate/library"))
	api.HandleFunc("POST /api/gate/library", gatePass("POST", "/_gate/library"))
	api.HandleFunc("POST /api/gate/library/install", gatePass("POST", "/_gate/library/install"))
	api.HandleFunc("DELETE /api/gate/library/{id}", func(w http.ResponseWriter, r *http.Request) {
		var out any
		if err := gateJSON("DELETE", "/_gate/library/"+url.PathEscape(r.PathValue("id")), nil, &out); err != nil {
			code := 502
			if ge, ok := err.(*GateError); ok && ge.Status >= 400 {
				code = ge.Status
			}
			jsonOut(w, code, map[string]any{"error": err.Error(), "status": code})
			return
		}
		jsonOut(w, 200, out)
	})

	api.HandleFunc("POST /api/pair/start", pairStart)
	localRoutes(api)
	aiRoutes(api)
	api.HandleFunc("GET /api/license", licenseGetHandler)
	api.HandleFunc("POST /api/license/activate", licenseActivateHandler)
	api.HandleFunc("POST /api/license/deactivate", licenseDeactivateHandler)
	api.HandleFunc("POST /api/notify/test", notifyTestHandler)
	api.HandleFunc("GET /api/sync/export", syncExportHandler)
	api.HandleFunc("POST /api/sync/import", syncImportHandler)
	api.HandleFunc("GET /api/gpu/stats", gpuStatsHandler)
	api.HandleFunc("GET /api/update/check", updateCheckHandler)
	api.HandleFunc("POST /api/update/apply", updateApplyHandler)
	api.HandleFunc("GET /api/update/status", updateStatusHandler)
	api.HandleFunc("POST /api/llm/write", llmWriteHandler)
	api.HandleFunc("/api/prompt-guide", promptGuideHandler)
	api.HandleFunc("POST /api/llm/test", llmTestHandler)
	api.HandleFunc("POST /api/llm/models", llmModelsHandler)
	api.HandleFunc("GET /api/pair/state", func(w http.ResponseWriter, r *http.Request) {
		pair.mu.Lock()
		defer pair.mu.Unlock()
		jsonOut(w, 200, map[string]any{"state": pair.state, "code": pair.code, "url": pair.url, "message": pair.msg})
	})

	// ---- templates ----
	api.HandleFunc("GET /api/profile-workflows/{profile}/{workflow}", profileWorkflowFile)
	api.HandleFunc("GET /api/templates", func(w http.ResponseWriter, r *http.Request) {
		out := []map[string]any{}
		for _, t := range listTemplates() {
			out = append(out, map[string]any{"id": t.ID, "name": t.Name, "created": t.Created, "nodes": len(t.Graph), "hidden": t.Hidden, "profile": t.Profile, "fields": detectFields(t)})
		}
		jsonOut(w, 200, out)
	})
	api.HandleFunc("POST /api/templates", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name string          `json:"name"`
			JSON json.RawMessage `json:"json"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&in); err != nil {
			errOut(w, 400, err)
			return
		}
		var raw []byte = in.JSON
		var s string
		if json.Unmarshal(in.JSON, &s) == nil { // sent as a string
			raw = []byte(s)
		}
		g, err := parseWorkflow(raw)
		if err != nil {
			errOut(w, 400, err)
			return
		}
		name := strings.TrimSpace(in.Name)
		if name == "" {
			name = "Flujo sin nombre"
		}
		t := &Template{Name: name, Graph: g}
		if err := saveTemplate(t); err != nil {
			errOut(w, 500, err)
			return
		}
		jsonOut(w, 200, map[string]any{"id": t.ID, "fields": detectFields(t)})
	})
	api.HandleFunc("POST /api/templates/{id}", func(w http.ResponseWriter, r *http.Request) {
		t, err := loadTemplate(r.PathValue("id"))
		if err != nil {
			errOut(w, 404, err)
			return
		}
		var in struct {
			Name   *string  `json:"name"`
			Hidden []string `json:"hidden"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
			t.Name = strings.TrimSpace(*in.Name)
		}
		if in.Hidden != nil {
			t.Hidden = in.Hidden
		}
		saveTemplate(t)
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	api.HandleFunc("DELETE /api/templates/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, err := loadTemplate(id); err != nil {
			errOut(w, 404, err)
			return
		}
		os.Remove(tplPath(id))
		jsonOut(w, 200, map[string]bool{"ok": true})
	})

	// ---- jobs ----
	api.HandleFunc("GET /api/jobs", func(w http.ResponseWriter, r *http.Request) { jsonOut(w, 200, store.snapshot()) })
	api.HandleFunc("POST /api/jobs", createJob)
	api.HandleFunc("POST /api/jobs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		j := store.get(r.PathValue("id"))
		if j == nil {
			errOut(w, 404, os.ErrNotExist)
			return
		}
		store.update(j, func(j *Job) {
			if j.Status == "queued" || j.Status == "waiting" {
				j.Status, j.Message, j.Finished = "canceled", "Cancelado", time.Now().Unix()
			} else {
				j.cancel = true
			}
		})
		store.poke()
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	api.HandleFunc("POST /api/jobs/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		j := store.get(r.PathValue("id"))
		if j == nil {
			errOut(w, 404, os.ErrNotExist)
			return
		}
		store.update(j, func(j *Job) {
			if j.Status == "failed" || j.Status == "canceled" || j.Status == "done" {
				j.Status, j.Message, j.PromptID, j.Progress, j.Outputs, j.cancel = "queued", "Reencolado", "", 0, nil, false
				j.Started, j.Finished, j.QueuePos = 0, 0, 0
			}
		})
		store.poke()
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	api.HandleFunc("POST /api/jobs/{id}/hires", func(w http.ResponseWriter, r *http.Request) {
		src := store.get(r.PathValue("id"))
		if src == nil {
			errOut(w, 404, errString("La tarea no existe"))
			return
		}
		store.mu.Lock()
		s := *src
		store.mu.Unlock()
		if s.Status != "done" {
			errOut(w, 409, errString("El borrador aún no ha terminado"))
			return
		}
		j, err := queueHiresJob(&s)
		if err != nil {
			errOut(w, 404, err)
			return
		}
		jsonOut(w, 200, map[string]any{"id": j.ID})
	})
	api.HandleFunc("DELETE /api/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		j := store.get(r.PathValue("id"))
		if j != nil && (j.Status == "queued" || j.Status == "waiting" || j.Status == "failed" || j.Status == "done" || j.Status == "canceled") {
			store.remove(j.ID)
			jsonOut(w, 200, map[string]bool{"ok": true})
			return
		}
		errOut(w, 409, errString("Cancela la tarea en ejecución primero"))
	})
	api.HandleFunc("POST /api/jobs/clear", func(w http.ResponseWriter, r *http.Request) {
		for _, j := range store.snapshot() {
			if j.Status == "done" || j.Status == "canceled" || j.Status == "failed" {
				store.remove(j.ID)
			}
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
	})

	// ---- prompt library ----
	api.HandleFunc("GET /api/prompts", func(w http.ResponseWriter, r *http.Request) {
		p := loadPrompts()
		if len(p) == 0 {
			p = defaultPrompts()
		}
		jsonOut(w, 200, p)
	})
	api.HandleFunc("POST /api/prompts", func(w http.ResponseWriter, r *http.Request) {
		var in []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			errOut(w, 400, err)
			return
		}
		writeJSON(filepath.Join(dataDir, "prompts.json"), in)
		jsonOut(w, 200, map[string]bool{"ok": true})
	})

	// ---- local results ----
	api.HandleFunc("GET /api/files", listFiles)
	api.HandleFunc("GET /api/file", serveFile)
	api.HandleFunc("POST /api/open", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		p := in.Path
		if p == "" {
			p = getConfig().OutDir
			os.MkdirAll(p, 0o755)
		}
		if !insideOut(p) && filepath.Clean(p) != filepath.Clean(getConfig().OutDir) {
			errOut(w, 403, errString("Solo se pueden abrir archivos de la carpeta de salida"))
			return
		}
		openPath(p)
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	api.HandleFunc("POST /api/open-url", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			URL string `json:"url"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		if in.URL == "comfy" {
			in.URL = baseURL() + "/"
			if localMode() {
				in.URL = lg.baseURL() + "/?wbk=" + lg.key
			}
		}
		if strings.HasPrefix(in.URL, "https://") || strings.HasPrefix(in.URL, "http://") {
			openBrowser(in.URL)
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	api.HandleFunc("POST /api/delete-file", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		if !insideOut(in.Path) {
			errOut(w, 403, errString("Solo se pueden eliminar archivos de la carpeta de salida"))
			return
		}
		if err := os.Remove(in.Path); err != nil {
			errOut(w, 500, err)
			return
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
	})

	registerCustomModelRoutes(api)
	registerUserdataRoutes(api)
	registerOnboardingRoutes(api)
	registerUsageRoutes(api)
	registerMobileRoutes(api)

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		k := r.Header.Get("X-Key")
		if k == "" {
			k = r.URL.Query().Get("k")
		}
		if !isValidAPIKey(k) {
			if c, err := r.Cookie("wl_mob"); err == nil {
				k = c.Value
			}
		}
		if !isValidAPIKey(k) {
			http.Error(w, "forbidden", 403)
			return
		}
		api.ServeHTTP(w, r)
	})
	return mux
}

type errString string

func (e errString) Error() string { return string(e) }

func queueHiresJob(s *Job) (*Job, error) {
	if s == nil {
		return nil, errors.New("tarea no encontrada")
	}
	if _, err := loadTemplate(s.TemplateID); err != nil {
		return nil, errors.New("plantilla no encontrada")
	}
	vals := map[string]any{}
	for k, v := range s.Values {
		vals[k] = v
	}
	for k, v := range s.UsedSeeds { // lock the seeds the trial actually used
		vals[k] = v
	}
	up := map[string]string{}
	for k, v := range s.Uploads {
		up[k] = v
	}
	title := strings.TrimSuffix(strings.TrimSuffix(s.Title, " · 草稿"), " · Borrador")
	title = strings.TrimSuffix(title, " · Borrador")
	j := &Job{
		ID:           newID() + "-h",
		TemplateID:   s.TemplateID,
		TemplateName: s.TemplateName,
		Title:        title + " · HD",
		Values:       vals,
		Uploads:      up,
		Status:       "queued",
		Message:      "En cola (versión HD)",
		Created:      time.Now().Unix(),
		ParentID:     s.ID,
		FullRes:      s.FullRes,
	}
	store.add(j)
	return j, nil
}

func createJob(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(256 << 20); err != nil {
		errOut(w, 400, err)
		return
	}
	var spec struct {
		TemplateID  string         `json:"template_id"`
		Values      map[string]any `json:"values"`
		RandomSeeds []string       `json:"random_seeds"`
		Title       string         `json:"title"`
		Count       int            `json:"count"`
		Draft       bool           `json:"draft"`
		AutoHires   bool           `json:"auto_hires"`
	}
	if err := json.Unmarshal([]byte(r.FormValue("spec")), &spec); err != nil {
		errOut(w, 400, err)
		return
	}
	t, err := loadTemplate(spec.TemplateID)
	if err != nil {
		errOut(w, 404, errString("La plantilla no existe"))
		return
	}
	if spec.Count < 1 {
		spec.Count = 1
	}
	if spec.Count > 50 {
		spec.Count = 50
	}
	if (spec.Count > 1 || spec.AutoHires) && !IsPro() {
		errOut(w, 403, errString("La generación por lotes (Batch) y el pipeline encadenado Auto-HD requieren una licencia WakeGPU Pro activa."))
		return
	}
	var draftSet map[string]any
	var draftRes, fullRes string
	if spec.Draft {
		c := getConfig()
		draftSet, draftRes, fullRes = draftPlan(t, spec.Values, c.DraftScale, c.DraftSteps)
		if draftRes == "" {
			errOut(w, 400, errString("este flujo no tiene dimensiones configuradas para reducir automáticamente a borrador"))
			return
		}
	}
	base := newID()
	uploads := map[string]string{}
	if r.MultipartForm != nil {
		for key, fhs := range r.MultipartForm.File {
			if len(fhs) == 0 {
				continue
			}
			fh := fhs[0]
			src, err := fh.Open()
			if err != nil {
				continue
			}
			name := unsafeName.ReplaceAllString(filepath.Base(fh.Filename), "_")
			dst := filepath.Join(dataDir, "uploads", base+"_"+sanitizeKey(key)+"__"+name)
			f, err := os.Create(dst)
			if err == nil {
				io.Copy(f, src)
				f.Close()
				uploads[key] = dst
			}
			src.Close()
		}
	}
	// reuse an earlier job's upload (for "use again")
	for k, v := range spec.Values {
		if s, ok := v.(string); ok && strings.HasPrefix(s, "@upload:") {
			p := strings.TrimPrefix(s, "@upload:")
			if filepath.Dir(p) == filepath.Join(dataDir, "uploads") {
				if _, err := os.Stat(p); err == nil {
					uploads[k] = p
				}
			}
			delete(spec.Values, k)
		}
	}
	ids := []string{}
	for i := 0; i < spec.Count; i++ {
		jobTitle := spec.Title
		if spec.Count > 1 && jobTitle != "" {
			jobTitle = fmt.Sprintf("%s (%d/%d)", spec.Title, i+1, spec.Count)
		}
		j := &Job{
			ID:          base + "-" + itoa(i),
			TemplateID:  t.ID,
			TemplateName: t.Name,
			Title:       jobTitle,
			Values:      spec.Values,
			Uploads:     uploads,
			RandomSeeds: spec.RandomSeeds,
			Status:      "queued",
			Message:     "En cola",
			Created:     time.Now().Unix(),
			Draft:       spec.Draft,
			DraftSet:    draftSet,
			DraftRes:    draftRes,
			FullRes:     fullRes,
			AutoHires:   spec.AutoHires,
		}
		if j.Title == "" {
			if spec.Count > 1 {
				j.Title = fmt.Sprintf("%s (%d/%d)", t.Name, i+1, spec.Count)
			} else {
				j.Title = t.Name
			}
		}
		store.add(j)
		ids = append(ids, j.ID)
	}
	jsonOut(w, 200, map[string]any{"ids": ids})
}

func itoa(i int) string { return strconv.Itoa(i) }

func sanitizeKey(k string) string {
	return unsafeName.ReplaceAllString(strings.ReplaceAll(k, ".", "-"), "_")
}

func defaultPrompts() []map[string]any {
	now := time.Now().UnixMilli()
	return []map[string]any{
		{
			"name": "🎬 Muse/Wan 2.1: Cortometraje en 6 Bloques",
			"mode": "T2VA",
			"at":   now,
			"text": `[DURACIÓN Y FORMATO]: 5.0s, 16:9 cinematic aspect ratio, 24fps.
[PERSONAJE / ASSET ID]: S1, 28-year-old female, sharp facial features, emerald eyes, messy dark bun, wearing a tailored charcoal wool coat and leather gloves.
[ESCENARIO Y ATMÓSFERA]: Rainy neo-noir city alley at dusk, neon signs reflecting in wet asphalt puddles, soft cyan and amber rim lighting, light steam rising from manholes.
[TIMED BEATS]:
- 0.0s - 2.5s: S1 walks slowly into the frame, raindrops splashing around her boots; she stops and glances towards camera.
- 2.5s - 5.0s: S1 lifts her right hand, catching raindrops, subtle breath vapor forming in the cold air as neon lights flicker.
[LENGUAJE DE CÁMARA]: 35mm anamorphic prime lens, shallow depth of field, slow smooth dolly forward at eye-level, cinematic film grain.
[RESTRICCIONES]: No face morphing, no limb distortion, realistic fluid physics, no text overlay, consistent lighting.`,
		},
		{
			"name": "🍎 Estilo Comercial (Apple Don't Blink)",
			"mode": "T2VA",
			"at":   now,
			"text": `[DURACIÓN Y FORMATO]: 5.0s, 16:9 widescreen, ultra-crisp commercial feel.
[SUJETO / ASSET ID]: Matte black titanium futuristic device with glowing amber edge ring, spinning slowly in mid-air.
[ESCENARIO Y ATMÓSFERA]: Infinite minimalist light gray void, studio softbox lighting with crisp highlights tracing the metallic edges.
[TIMED BEATS]:
- 0.0s - 2.0s: Fast explosive snap zoom onto the device power button as a haptic pulse ripples through the surface.
- 2.0s - 5.0s: 360-degree rapid orbit showing precision laser-etched ports, settling into a hero angle with dramatic studio shadows.
[LENGUAJE DE CÁMARA]: 90mm macro lens, ultra-sharp f/4, high-speed robotic arm motion (120fps slow-motion feel), zero motion blur on key product accents.
[RESTRICCIONES]: No artifacts, no jitter, perfectly smooth geometric lines, clean industrial design look.`,
		},
		{
			"name": "🌧️ Sci-Fi Monumental (Blade Runner 2049)",
			"mode": "T2VA",
			"at":   now,
			"text": `[DURACIÓN Y FORMATO]: 6.0s, 2.39:1 cinemascope, heavy cinematic haze.
[PERSONAJE / ASSET ID]: S1, lone wanderer in a weathered brown trench coat with fur collar, back turned to camera.
[ESCENARIO Y ATMÓSFERA]: Barren apocalyptic wasteland under a dense burnt-orange dust storm; in the distance, colossal decaying brutalist statues tower into the smog.
[TIMED BEATS]:
- 0.0s - 3.0s: S1 stands motionless gazing up at the gargantuan monuments while dense orange dust whips across the desolate ground.
- 3.0s - 6.0s: S1 takes two heavy steps forward; a faint blue holographic scan sweep faintly illuminates the dust particles from above.
[LENGUAJE DE CÁMARA]: Extreme wide shot, 24mm wide angle, slow pedestal rise revealing the impossible scale of the architecture.
[RESTRICCIONES]: Realistic dust physics, no oversaturated colors, somber contemplative pacing.`,
		},
		{
			"name": "🕵️ Thriller Psicológico Noir (David Fincher)",
			"mode": "T2VA",
			"at":   now,
			"text": `[DURACIÓN Y FORMATO]: 5.0s, 16:9, muted olive-green and deep shadow color grade.
[PERSONAJE / ASSET ID]: S1, detective in wrinkled white dress shirt and loosened tie, intense focused expression, beads of sweat on forehead.
[ESCENARIO Y ATMÓSFERA]: Dimly lit archival basement office, single tungsten green-shaded desk lamp casting stark geometric shadows through venetian blinds.
[TIMED BEATS]:
- 0.0s - 2.5s: Extreme close-up on S1's eyes reflecting a flickering monitor; pupils dilate as he deciphers a document.
- 2.5s - 5.0s: S1 slowly leans back into the darkness, one hand tapping a silver fountain pen against the wooden desk.
[LENGUAJE DE CÁMARA]: 50mm Zeiss prime lens, clinical tripod stability, micro-push-in, low contrast, rich filmic blacks.
[RESTRICCIONES]: No shaky cam, razor sharp focus plane, restrained minimal movement.`,
		},
		{
			"name": "🌸 Anime Cinematográfico (Makoto Shinkai)",
			"mode": "T2VA",
			"at":   now,
			"text": `[DURACIÓN Y FORMATO]: 5.0s, 16:9, vibrant high-key anime aesthetics.
[PERSONAJE / ASSET ID]: S1, young high school student with shoulder-length black hair fluttering in the wind, wearing a white school uniform with blue ribbon.
[ESCENARIO Y ATMÓSFERA]: Sunlit Tokyo rooftop overlooking a sprawling metropolis; breathtaking summer sky with towering volumetric cumulus clouds and lens flares.
[TIMED BEATS]:
- 0.0s - 2.5s: S1 reaches her hand out toward the boundless azure sky; golden afternoon sunlight glints between her fingers.
- 2.5s - 5.0s: Pink cherry blossom petals drift past in slow motion as S1 turns with an emotional, hopeful smile.
[LENGUAJE DE CÁMARA]: 35mm anime perspective, dynamic low-angle shot, golden hour chromatic aberration, radiant light blooms.
[RESTRICCIONES]: No 3D uncanny valley, authentic 2D anime linework, smooth natural cloth and hair animation.`,
		},
		{
			"name": "💎 Macro Cinema / Joyería & Cristal (120fps)",
			"mode": "T2VA",
			"at":   now,
			"text": `[DURACIÓN Y FORMATO]: 4.0s, 16:9, luxury commercial slow-motion.
[SUJETO / ASSET ID]: Faceted crystalline emerald pendant suspended in mid-air surrounded by dancing liquid gold droplets.
[ESCENARIO Y ATMÓSFERA]: Deep velvet black backdrop with subtle caustic light refractions dancing across the glass facets.
[TIMED BEATS]:
- 0.0s - 2.0s: Single golden droplet impacts the top facet of the gem, exploding into a radial crown splash in ultra-slow motion.
- 2.0s - 4.0s: Gem gently rotates 45 degrees, prismatic light beams scattering rainbows across the frame.
[LENGUAJE DE CÁMARA]: 100mm macro probe lens, extreme shallow depth of field, 1000fps phantom camera feel, ultra-precise focus racking.
[RESTRICCIONES]: No liquid clipping, physically accurate optical refraction, pure luxury aesthetics.`,
		},
	}
}

func loadPrompts() []map[string]any {
	out := []map[string]any{}
	if b, err := os.ReadFile(filepath.Join(dataDir, "prompts.json")); err == nil {
		json.Unmarshal(b, &out)
	}
	return out
}

// ---- SSE passthrough of /_gate/events (boot logs & progress) ----
func sseProxy(w http.ResponseWriter, r *http.Request) {
	b := baseURL()
	if b == "" {
		http.Error(w, "no url", 400)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "GET", b+"/_gate/events", nil)
	addAuth(req)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 || !strings.Contains(resp.Header.Get("Content-Type"), "event-stream") {
		http.Error(w, "upstream "+resp.Status, 502)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	fl, _ := w.(http.Flusher)
	flush := func() {
		if fl != nil {
			fl.Flush()
		}
	}
	// whole upstream events (up to the blank line), so the app's own log lines (userdata.go) can be
	// slotted in between events without breaking one
	events := make(chan []byte, 64)
	go func() {
		defer close(events)
		rd := bufio.NewReader(resp.Body)
		var ev []byte
		for {
			line, err := rd.ReadBytes('\n')
			ev = append(ev, line...)
			if len(line) > 0 && (line[0] == '\n' || string(line) == "\r\n") || err != nil {
				if len(ev) > 0 {
					select {
					case events <- ev:
					case <-r.Context().Done():
						return
					}
				}
				ev = nil
			}
			if err != nil {
				return
			}
		}
	}()
	appCh, backlog, unsub := appLogSubscribe()
	defer unsub()
	// the gateway replays its backlog first; add ours after it has settled
	replay := time.After(800 * time.Millisecond)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return
			}
			w.Write(ev)
			flush()
		case <-replay:
			for _, l := range backlog {
				w.Write(sseLogEvent(l))
			}
			flush()
		case l := <-appCh:
			w.Write(sseLogEvent(l))
			flush()
		case <-r.Context().Done():
			return
		}
	}
}

// ---- device-code pairing (RFC 8628, same flow as `ckit auth`) ----
var pair struct {
	mu                    sync.Mutex
	state, code, url, msg string
}

func pairStart(w http.ResponseWriter, r *http.Request) {
	var res struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
		VerifyURL  string `json:"verification_uri_complete"`
		Interval   int    `json:"interval"`
		ExpiresIn  int    `json:"expires_in"`
	}
	if err := gateJSON("POST", "/api/auth/device/code", map[string]string{"client_name": "WakeGPU"}, &res); err != nil {
		errOut(w, 502, err)
		return
	}
	if res.VerifyURL == "" {
		res.VerifyURL = baseURL() + "/auth/device?code=" + res.UserCode
	}
	pair.mu.Lock()
	pair.state, pair.code, pair.url, pair.msg = "pending", res.UserCode, res.VerifyURL, "Confirma en la página del navegador que se ha abierto"
	pair.mu.Unlock()
	openBrowser(res.VerifyURL)
	go func() {
		iv := res.Interval
		if iv < 2 {
			iv = 3
		}
		exp := res.ExpiresIn
		if exp <= 0 {
			exp = 600
		}
		deadline := time.Now().Add(time.Duration(exp) * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(time.Duration(iv) * time.Second)
			var tok struct {
				AccessToken string `json:"access_token"`
				Email       string `json:"email"`
			}
			err := gateJSON("POST", "/api/auth/device/token", map[string]string{"device_code": res.DeviceCode}, &tok)
			if err == nil && tok.AccessToken != "" {
				c := getConfig()
				c.Token = tok.AccessToken
				saveConfig(c)
				pair.mu.Lock()
				pair.state, pair.msg = "ok", "Emparejado con éxito: "+tok.Email
				pair.mu.Unlock()
				store.poke()
				return
			}
			if ge, ok := err.(*GateError); ok {
				switch ge.Code {
				case "authorization_pending", "":
					continue
				case "slow_down":
					iv += 2
					continue
				default:
					pair.mu.Lock()
					pair.state, pair.msg = "error", "Error de emparejamiento: "+ge.Error()
					pair.mu.Unlock()
					return
				}
			}
		}
		pair.mu.Lock()
		pair.state, pair.msg = "error", "Tiempo de espera agotado al emparejar, reintenta"
		pair.mu.Unlock()
	}()
	jsonOut(w, 200, map[string]any{"code": res.UserCode, "url": res.VerifyURL})
}

// ---- results folder ----
func insideOut(p string) bool {
	out, err1 := filepath.Abs(getConfig().OutDir)
	ap, err2 := filepath.Abs(p)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(out, ap)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..")
}

func listFiles(w http.ResponseWriter, r *http.Request) {
	out := getConfig().OutDir
	type F struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		Dir   string `json:"dir"`
		Kind  string `json:"kind"`
		Size  int64  `json:"size"`
		Mtime int64  `json:"mtime"`
	}
	var fsList []F
	filepath.WalkDir(out, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		k := fileKind(d.Name())
		if k == "file" || strings.HasSuffix(d.Name(), ".part") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(out, filepath.Dir(p))
		fsList = append(fsList, F{d.Name(), p, rel, k, info.Size(), info.ModTime().Unix()})
		return nil
	})
	sort.Slice(fsList, func(i, j int) bool { return fsList[i].Mtime > fsList[j].Mtime })
	if len(fsList) > 500 {
		fsList = fsList[:500]
	}
	if fsList == nil {
		fsList = []F{}
	}
	jsonOut(w, 200, map[string]any{"dir": out, "files": fsList})
}

func serveFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if !insideOut(p) {
		http.Error(w, "forbidden", 403)
		return
	}
	http.ServeFile(w, r, p)
}

func openPath(p string) {
	switch runtime.GOOS {
	case "windows":
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			exec.Command("explorer", "/select,", p).Start()
		} else {
			exec.Command("explorer", p).Start()
		}
	case "darwin":
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			exec.Command("open", p).Start()
		} else {
			exec.Command("open", "-R", p).Start()
		}
	default:
		exec.Command("xdg-open", filepath.Dir(p)).Start()
	}
}

func openBrowser(u string) {
	switch runtime.GOOS {
	case "windows":
		exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
	case "darwin":
		exec.Command("open", u).Start()
	default:
		exec.Command("xdg-open", u).Start()
	}
}

// statusRecorder remembers the status code a wrapped handler wrote.
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (s *statusRecorder) WriteHeader(c int) { s.code = c; s.ResponseWriter.WriteHeader(c) }
