package main

// "AI" page: chat with the LLM served by Ollama on the VM (reached through ComfyUI's /wbllm route)
// and a one-click text-to-image template for checkpoint profiles. Both work in gateway and local mode.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// aiSummary normalises a local profile's `ai:` block the same way the kit's profiles.py does.
func (p *LocalProfile) aiSummary() map[string]any {
	if p.AI == nil {
		return nil
	}
	kind, _ := p.AI["type"].(string)
	if kind != "llm" && kind != "image" {
		return nil
	}
	dest := map[string]string{}
	for _, m := range p.Models {
		dest[m.ID] = m.Dest
	}
	modelName := func(mid string) string {
		_, relative, _ := strings.Cut(dest[mid], "/")
		return relative // Preserve subfolders, matching ComfyUI's loader names.
	}
	sub, _ := p.AI[kind].(map[string]any)
	if sub == nil {
		sub = map[string]any{}
	}
	mid := fmt.Sprint(sub["model"])
	if dest[mid] == "" {
		return nil
	}
	uses := []string{mid}
	num := func(k string, d float64) float64 {
		switch v := sub[k].(type) {
		case int:
			return float64(v)
		case float64:
			return v
		}
		return d
	}
	str := func(k, d string) string {
		if v, ok := sub[k].(string); ok && v != "" {
			return v
		}
		return d
	}
	out := map[string]any{"type": kind, "title": fmt.Sprint(nonNilStr(p.AI["title"]))}
	if kind == "llm" {
		think := true
		if v, ok := sub["think"].(bool); ok {
			think = v
		}
		out["llm"] = map[string]any{"model": mid, "dest": dest[mid], "name": str("name", "wb-llm"), "ctx": int(num("ctx", 32768)),
			"think": think, "temperature": num("temperature", 0.7), "system": str("system", "")}
	} else {
		arch := str("arch", "sdxl")
		im := map[string]any{"arch": arch, "model": mid, "negative": str("negative", ""), "shift": num("shift", 1)}
		if arch == "chroma" {
			clip, vae := fmt.Sprint(sub["clip"]), fmt.Sprint(sub["vae"])
			if dest[clip] == "" || dest[vae] == "" {
				return nil
			}
			im["clip"], im["vae"] = clip, vae
			im["unet_name"], im["clip_name"], im["vae_name"] = modelName(mid), modelName(clip), modelName(vae)
			uses = append(uses, clip, vae)
			im["width"], im["height"], im["steps"], im["cfg"] = int(num("width", 1024)), int(num("height", 1024)), int(num("steps", 26)), num("cfg", 3.8)
			im["sampler"], im["scheduler"] = str("sampler", "euler"), str("scheduler", "beta")
		} else {
			im["checkpoint"] = modelName(mid)
			im["width"], im["height"], im["steps"], im["cfg"] = int(num("width", 1024)), int(num("height", 1024)), int(num("steps", 30)), num("cfg", 5)
			im["sampler"], im["scheduler"] = str("sampler", "dpmpp_sde"), str("scheduler", "karras")
		}
		out["image"] = im
	}
	models := []string{}
	if l, ok := p.AI["models"].([]any); ok {
		for _, m := range l {
			models = append(models, fmt.Sprint(m))
		}
	}
	for _, u := range uses {
		found := false
		for _, m := range models {
			found = found || m == u
		}
		if !found {
			models = append(models, u)
		}
	}
	out["models"] = models
	return out
}

func nonNilStr(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// aiRequest sends a request to the VM's /wbllm/... route (via the gateway or the local gate).
func aiRequest(r *http.Request, method, p string, body []byte) (*http.Response, error) {
	b := baseURL()
	if b == "" {
		return nil, errors.New("Aún no se ha configurado el modo Pasarela / Local")
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(r.Context(), method, b+"/wbllm/"+p, rd)
	if err != nil {
		return nil, err
	}
	addAuth(req)
	req.Header.Set("Content-Type", "application/json")
	return (&http.Client{Transport: transport}).Do(req)
}

func aiInfoHandler(w http.ResponseWriter, r *http.Request) {
	resp, err := aiRequest(r, "GET", "info", nil)
	if err != nil {
		jsonOut(w, 200, map[string]any{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out map[string]any
	if resp.StatusCode >= 400 || json.Unmarshal(raw, &out) != nil {
		msg := fmt.Sprintf("Servicio de IA no disponible en la GPU (HTTP %d). Asegúrate de haber arrancado con un perfil de IA.", resp.StatusCode)
		if resp.StatusCode == 404 {
			msg = "El entorno de GPU aún no soporta la pestaña IA (requiere parche gate-ai.py y perfil de IA)"
		}
		jsonOut(w, 200, map[string]any{"error": msg, "status": resp.StatusCode})
		return
	}
	if out["type"] == "image" {
		im, _ := out["image"].(map[string]any)
		graph := imageLoaderGraph(im)
		if err := checkImageModels(graph); err != nil {
			out["ready"], out["error"] = false, err.Error()
		} else {
			out["ready"] = true
		}
	}
	jsonOut(w, 200, out)
}

func imageLoaderGraph(im map[string]any) map[string]map[string]any {
	graph := map[string]map[string]any{}
	fields := map[string]string{"CheckpointLoaderSimple": "ckpt_name"}
	values := map[string]any{"ckpt_name": im["checkpoint"]}
	if im["arch"] == "chroma" {
		fields = map[string]string{"UNETLoader": "unet_name", "CLIPLoader": "clip_name", "VAELoader": "vae_name"}
		values = im
	}
	for class, field := range fields {
		graph[class] = map[string]any{"class_type": class, "inputs": map[string]any{field: values[field]}}
	}
	return graph
}

// Check the running ComfyUI's loader lists, not just a profile's declared files.
// Used for old VMs too, before submitting a prompt which would otherwise fail validation.
func checkImageModels(graph map[string]map[string]any) error {
	fields := map[string]string{"UNETLoader": "unet_name", "CLIPLoader": "clip_name", "VAELoader": "vae_name", "CheckpointLoaderSimple": "ckpt_name"}
	ids := make([]string, 0, len(graph))
	for id := range graph {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		n := graph[id]
		class, _ := n["class_type"].(string)
		field := fields[class]
		if field == "" {
			continue
		}
		inputs, _ := n["inputs"].(map[string]any)
		wanted, _ := inputs[field].(string)
		if wanted == "" {
			return errors.New("Falta el nombre del modelo en la plantilla; vuelve a la pestaña IA para crearla")
		}
		var info map[string]struct {
			Input struct {
				Required map[string][]json.RawMessage `json:"required"`
			} `json:"input"`
		}
		if err := gateJSON("GET", "/object_info/"+class, nil, &info); err != nil {
			return fmt.Errorf("No se pudieron verificar los modelos en la GPU; comprueba la conexión: %w", err)
		}
		definition := info[class].Input.Required[field]
		var names []string
		if len(definition) == 0 || json.Unmarshal(definition[0], &names) != nil {
			return fmt.Errorf("ComfyUI en la GPU no devolvió la lista de modelos %s; revisa el registro de arranque", class)
		}
		found := false
		for _, name := range names {
			if strings.ReplaceAll(name, "\\", "/") == strings.ReplaceAll(wanted, "\\", "/") {
				found = true
				break
			}
		}
		if !found {
			available := "ninguno"
			if len(names) > 0 {
				shown := names
				if len(shown) > 5 {
					shown = shown[:5]
				}
				available = strings.Join(shown, "、")
				if len(names) > 5 {
					available += "…"
				}
			}
			return fmt.Errorf("No se encontró el modelo %s en la GPU (%d disponibles de tipo %s, actuales: %s). Revisa la descarga de modelos.", wanted, len(names), class, available)
		}
	}
	return nil
}

// aiChatHandler streams Ollama's NDJSON chat response straight through to the page.
func aiChatHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Model       string           `json:"model"`
		Messages    []map[string]any `json:"messages"`
		Think       *bool            `json:"think"`
		Temperature *float64         `json:"temperature"`
		NumCtx      int              `json:"num_ctx"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&in); err != nil || in.Model == "" || len(in.Messages) == 0 {
		errOut(w, 400, errString("Formato de petición inválido"))
		return
	}
	body := map[string]any{"model": in.Model, "messages": in.Messages, "stream": true, "keep_alive": -1}
	if in.Think != nil {
		body["think"] = *in.Think
	}
	opts := map[string]any{}
	if in.Temperature != nil {
		opts["temperature"] = *in.Temperature
	}
	if in.NumCtx > 0 {
		opts["num_ctx"] = in.NumCtx
	}
	if len(opts) > 0 {
		body["options"] = opts
	}
	b, _ := json.Marshal(body)
	resp, err := aiRequest(r, "POST", "api/chat", b)
	if err != nil {
		errOut(w, 502, fmt.Errorf("No se pudo conectar al LLM en la GPU: %w", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(raw, &e)
		msg := e.Error
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
			if len(msg) > 200 || strings.Contains(msg, "<html") {
				msg = ""
			}
		}
		switch {
		case resp.StatusCode == 404 && msg == "not allowed":
			msg = "Acceso denegado"
		case resp.StatusCode == 404 && msg == "":
			msg = "Servicio IA no disponible en la GPU (requiere parche gate-ai.py y perfil de IA)"
		case resp.StatusCode == 503:
			msg = "El servicio LLM aún está iniciando; espera a que termine en el registro de arranque"
		}
		errOut(w, resp.StatusCode, fmt.Errorf("El LLM devolvió %d: %s", resp.StatusCode, msg))
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 16<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if fl != nil {
				fl.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

var aiTplID = regexp.MustCompile(`[^a-z0-9-]+`)

// aiImageTemplate creates (or refreshes) the built-in text-to-image template for a checkpoint profile.
func aiImageTemplateHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Profile    string  `json:"profile"`
		Title      string  `json:"title"`
		Arch       string  `json:"arch"`
		Checkpoint string  `json:"checkpoint"`
		UnetName   string  `json:"unet_name"`
		ClipName   string  `json:"clip_name"`
		VaeName    string  `json:"vae_name"`
		Shift      float64 `json:"shift"`
		Width      int     `json:"width"`
		Height     int     `json:"height"`
		Steps      int     `json:"steps"`
		CFG        float64 `json:"cfg"`
		Sampler    string  `json:"sampler"`
		Scheduler  string  `json:"scheduler"`
		Negative   string  `json:"negative"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil || in.Profile == "" ||
		(in.Arch == "chroma" && (in.UnetName == "" || in.ClipName == "" || in.VaeName == "")) || (in.Arch != "chroma" && in.Checkpoint == "") {
		errOut(w, 400, errString("Formato de petición inválido"))
		return
	}
	id := "ai-" + strings.Trim(aiTplID.ReplaceAllString(strings.ToLower(in.Profile), "-"), "-")
	var g map[string]map[string]any
	var keys map[string]string
	if in.Arch == "chroma" {
		g, keys = chromaGraph(in.UnetName, in.ClipName, in.VaeName, in.Negative, in.Width, in.Height, in.Steps, in.CFG, in.Shift, in.Sampler)
	} else {
		g, keys = sdxlGraph(in.Checkpoint, in.Negative, in.Width, in.Height, in.Steps, in.CFG, in.Sampler, in.Scheduler), sdxlKeys
	}
	t := &Template{ID: id, Name: "Imagen IA · " + firstNonEmpty(in.Title, in.Profile), Created: time.Now().Unix(), Graph: g, Profile: in.Profile}
	if old, err := loadTemplate(id); err == nil {
		t.Created, t.Hidden = old.Created, old.Hidden
	}
	if err := saveTemplate(t); err != nil {
		errOut(w, 500, err)
		return
	}
	jsonOut(w, 200, map[string]any{"id": t.ID, "name": t.Name, "keys": keys, "fields": detectFields(t)})
}

// where the AI page's form values go in each graph
var sdxlKeys = map[string]string{"prompt": "2.text", "negative": "3.text", "width": "4.width", "height": "4.height",
	"steps": "5.steps", "cfg": "5.cfg", "seed": "5.seed"}

// chromaGraph follows the official Chroma1-HD ComfyUI template: UNET + T5 (type chroma, tokenizer padding
// options) + FLUX VAE, AuraFlow shift 1.0, CFGGuider, euler with the beta schedule (alpha = beta = 0.45).
func chromaGraph(unet, clip, vae, negative string, wd, ht, steps int, cfg, shift float64, sampler string) (map[string]map[string]any, map[string]string) {
	if wd <= 0 {
		wd = 1024
	}
	if ht <= 0 {
		ht = 1024
	}
	if steps <= 0 {
		steps = 26
	}
	if cfg <= 0 {
		cfg = 3.8
	}
	if shift <= 0 {
		shift = 1
	}
	node := func(cls, title string, in map[string]any) map[string]any {
		return map[string]any{"class_type": cls, "inputs": in, "_meta": map[string]any{"title": title}}
	}
	l := func(id string, i int) []any { return []any{id, float64(i)} }
	g := map[string]map[string]any{
		"1":  node("UNETLoader", "Modelo", map[string]any{"unet_name": unet, "weight_dtype": "default"}),
		"2":  node("CLIPTextEncode", "Prompt Positivo", map[string]any{"text": "", "clip": l("11", 0)}),
		"3":  node("CLIPTextEncode", "Prompt Negativo (negative)", map[string]any{"text": negative, "clip": l("11", 0)}),
		"4":  node("EmptySD3LatentImage", "Lienzo", map[string]any{"width": float64(wd), "height": float64(ht), "batch_size": float64(1)}),
		"5":  node("RandomNoise", "Semilla aleatoria", map[string]any{"noise_seed": float64(0)}),
		"6":  node("VAEDecode", "Decodificador", map[string]any{"samples": l("15", 0), "vae": l("12", 0)}),
		"7":  node("SaveImage", "Guardar imagen", map[string]any{"filename_prefix": "ai", "images": l("6", 0)}),
		"8":  node("ModelSamplingAuraFlow", "Flow Shift", map[string]any{"shift": shift, "model": l("1", 0)}),
		"9":  node("CFGGuider", "Guía CFG", map[string]any{"cfg": cfg, "model": l("8", 0), "positive": l("2", 0), "negative": l("3", 0)}),
		"10": node("CLIPLoader", "Codificador de texto", map[string]any{"clip_name": clip, "type": "chroma", "device": "default"}),
		"11": node("T5TokenizerOptions", "Opciones T5", map[string]any{"min_padding": float64(1), "min_length": float64(0), "clip": l("10", 0)}),
		"12": node("VAELoader", "VAE", map[string]any{"vae_name": vae}),
		"13": node("KSamplerSelect", "Muestreador", map[string]any{"sampler_name": firstNonEmpty(sampler, "euler")}),
		"14": node("BetaSamplingScheduler", "Planificador", map[string]any{"steps": float64(steps), "alpha": 0.45, "beta": 0.45, "model": l("8", 0)}),
		"15": node("SamplerCustomAdvanced", "Muestreo", map[string]any{"noise": l("5", 0), "guider": l("9", 0), "sampler": l("13", 0),
			"sigmas": l("14", 0), "latent_image": l("4", 0)}),
	}
	return g, map[string]string{"prompt": "2.text", "negative": "3.text", "width": "4.width", "height": "4.height",
		"steps": "14.steps", "cfg": "9.cfg", "seed": "5.noise_seed"}
}

// sdxlGraph is a plain checkpoint text-to-image graph in ComfyUI API format.
func sdxlGraph(ckpt, negative string, wd, ht, steps int, cfg float64, sampler, scheduler string) map[string]map[string]any {
	if wd <= 0 {
		wd = 1024
	}
	if ht <= 0 {
		ht = 1024
	}
	if steps <= 0 {
		steps = 30
	}
	if cfg <= 0 {
		cfg = 5
	}
	sampler = firstNonEmpty(sampler, "dpmpp_sde")
	scheduler = firstNonEmpty(scheduler, "karras")
	node := func(cls, title string, in map[string]any) map[string]any {
		return map[string]any{"class_type": cls, "inputs": in, "_meta": map[string]any{"title": title}}
	}
	l := func(id string, i int) []any { return []any{id, float64(i)} }
	return map[string]map[string]any{
		"1": node("CheckpointLoaderSimple", "Modelo", map[string]any{"ckpt_name": ckpt}),
		"2": node("CLIPTextEncode", "Prompt Positivo", map[string]any{"text": "", "clip": l("1", 1)}),
		"3": node("CLIPTextEncode", "Prompt Negativo (negative)", map[string]any{"text": negative, "clip": l("1", 1)}),
		"4": node("EmptyLatentImage", "Lienzo", map[string]any{"width": float64(wd), "height": float64(ht), "batch_size": float64(1)}),
		"5": node("KSampler", "Muestreo", map[string]any{"seed": float64(0), "steps": float64(steps), "cfg": cfg,
			"sampler_name": sampler, "scheduler": scheduler, "denoise": 1.0,
			"model": l("1", 0), "positive": l("2", 0), "negative": l("3", 0), "latent_image": l("4", 0)}),
		"6": node("VAEDecode", "Decodificador", map[string]any{"samples": l("5", 0), "vae": l("1", 2)}),
		"7": node("SaveImage", "Guardar imagen", map[string]any{"filename_prefix": "ai", "images": l("6", 0)}),
	}
}

// aiOpenAIChatHandler proxies OpenAI /v1/chat/completions requests to the VM's Ollama instance,
// allowing IDE extensions (VS Code Continue.dev, Cursor, Cline, etc.) to talk to WakeGPU.
func aiOpenAIChatHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil || len(body) == 0 {
		http.Error(w, `{"error":{"message":"Invalid request body","type":"invalid_request_error"}}`, http.StatusBadRequest)
		return
	}

	resp, err := aiRequest(r, "POST", "v1/chat/completions", body)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "GPU LLM offline: " + err.Error(),
				"type":    "server_error",
			},
		})
		return
	}
	defer resp.Body.Close()

	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			break
		}
	}
}

// aiOpenAIModelsHandler returns the models available in OpenAI-compatible format.
func aiOpenAIModelsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	resp, err := aiRequest(r, "GET", "v1/models", nil)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data": []map[string]any{
				{"id": "qwen2.5-coder", "object": "model", "owned_by": "wakegpu"},
			},
		})
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func aiRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /api/ai/info", aiInfoHandler)
	api.HandleFunc("POST /api/ai/chat", aiChatHandler)
	api.HandleFunc("POST /api/ai/image-template", aiImageTemplateHandler)
	api.HandleFunc("POST /v1/chat/completions", aiOpenAIChatHandler)
	api.HandleFunc("OPTIONS /v1/chat/completions", aiOpenAIChatHandler)
	api.HandleFunc("GET /v1/models", aiOpenAIModelsHandler)
	api.HandleFunc("OPTIONS /v1/models", aiOpenAIModelsHandler)
}
