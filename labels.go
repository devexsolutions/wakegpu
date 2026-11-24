package main

// Spanish labels, explanations and recommended values for workflow parameters.
// Generic names come from the input name / node class; workflow-specific roles (e.g. the
// MiniMax H3 template's step switch and Lightning LoRA toggle) are recognised from the graph
// wiring, so they work whatever the nodes happen to be titled.

import "strings"

type inputInfo struct{ label, hint string }

var inputCN = map[string]inputInfo{
	"text":             {"Prompt", ""},
	"prompt":           {"Prompt", ""},
	"positive":         {"Prompt positivo", ""},
	"negative":         {"Prompt negativo", "Elementos que no quieres en la imagen"},
	"seed":             {"Semilla aleatoria", "Misma semilla + mismos parámetros ≈ mismo resultado"},
	"noise_seed":       {"Semilla aleatoria", "Misma semilla + mismos parámetros ≈ mismo resultado"},
	"steps":            {"Pasos de muestreo", "Más pasos dan más detalle pero tardan más"},
	"cfg":              {"Intensidad de guía (CFG)", "Más alto sigue más el prompt; demasiado alto satura"},
	"denoise":          {"Fuerza de redibujado (Denoise)", "En texto a vídeo mantener en 1"},
	"width":            {"Ancho", "Píxeles"},
	"height":           {"Alto", "Píxeles"},
	"megapixels":       {"Megapíxeles totales", "Define la resolución: 0.98 ≈ 1344×768 (768p oficial)"},
	"aspect_ratio":     {"Relación de aspecto", ""},
	"multiple":         {"Múltiplo de tamaño", "Ancho y alto serán múltiplos enteros de este valor"},
	"fps":              {"Fotogramas por segundo (FPS)", "Fotogramas por segundo"},
	"frame_rate":       {"Fotogramas por segundo (FPS)", "Fotogramas por segundo"},
	"length":           {"Fotogramas", ""},
	"num_frames":       {"Fotogramas", ""},
	"batch_size":       {"Tamaño de lote", "Imágenes generadas por ejecución"},
	"sampler_name":     {"Muestreador (Sampler)", ""},
	"scheduler":        {"Planificador (Scheduler)", ""},
	"filename_prefix":  {"Prefijo de archivo", ""},
	"format":           {"Formato de salida", ""},
	"codec":            {"Códec de vídeo", ""},
	"format.codec":     {"Códec de vídeo", ""},
	"image":            {"Imagen", ""},
	"audio":            {"Audio", ""},
	"video":            {"Vídeo", ""},
	"strength_model":   {"Fuerza de LoRA", ""},
	"strength_clip":    {"Fuerza de texto LoRA", ""},
	"lora_name":        {"Archivo LoRA", ""},
	"unet_name":        {"Archivo de modelo principal", ""},
	"ckpt_name":        {"Archivo de modelo", ""},
	"clip_name":        {"Archivo codificador de texto", ""},
	"vae_name":         {"Archivo VAE", ""},
	"weight_dtype":     {"Precisión de pesos", ""},
	"crf":              {"Calidad CRF", "Menor valor = mayor nitidez y mayor tamaño de archivo"},
	"upscale_method":   {"Algoritmo de escalado", ""},
	"resolution":       {"Resolución", ""},
	"max_resolution":   {"Resolución máxima (lado largo)", ""},
	"color_correction": {"Corrección de color", ""},
}

var classCN = map[string]string{
	"MiniMaxH3ImageToVideo": "Vídeo MiniMax H3", "ResolutionSelector": "Selector de resolución", "RandomNoise": "Ruido aleatorio",
	"BasicScheduler": "Planificador", "CreateVideo": "Crear vídeo", "SaveVideo": "Guardar vídeo", "KSamplerSelect": "Muestreador",
	"LoraLoaderModelOnly": "Carga de LoRA", "UNETLoader": "Carga de modelo principal", "CLIPLoader": "Carga de codificador de texto", "VAELoader": "Carga de VAE",
	"LoadImage": "Cargar imagen", "LoadAudio": "Cargar audio", "LoadVideo": "Cargar vídeo", "CLIPTextEncode": "Codificación de texto", "KSampler": "Muestreador K",
	"PrimitiveInt": "Entero", "PrimitiveFloat": "Decimal", "PrimitiveBoolean": "Interruptor", "PrimitiveString": "Texto", "ComfySwitchNode": "Conmutador condicional",
	"SeedVR2VideoUpscaler": "Escalador SeedVR2", "EmptyLatentImage": "Lienzo vacío", "SaveImage": "Guardar imagen",
}

// role describes what a literal input really controls, derived from the graph wiring.
type role struct {
	label, hint string
	rec         any
	primary     bool
}

type consumer struct{ node, input string }

// fieldRoles returns roles keyed by "<node>.<input>" for parameters whose meaning only shows in
// the wiring (Primitive nodes feeding switches, schedulers, math expressions, …).
func fieldRoles(g map[string]map[string]any) map[string]role {
	cons := map[string][]consumer{} // node id -> who reads its output
	for id, n := range g {
		in, _ := n["inputs"].(map[string]any)
		for k, v := range in {
			if isLink(v) {
				src := v.([]any)[0].(string)
				cons[src] = append(cons[src], consumer{id, k})
			}
		}
	}
	cls := func(id string) string { s, _ := g[id]["class_type"].(string); return s }
	// what does node id ultimately feed (following switches)?
	var feeds func(id string, depth int) []consumer
	feeds = func(id string, depth int) []consumer {
		var out []consumer
		for _, c := range cons[id] {
			if cls(c.node) == "ComfySwitchNode" && (c.input == "on_true" || c.input == "on_false") && depth < 3 {
				out = append(out, feeds(c.node, depth+1)...)
			} else {
				out = append(out, c)
			}
		}
		return out
	}
	roles := map[string]role{}
	hasLightningLora := false
	for id := range g {
		if cls(id) == "LoraLoaderModelOnly" {
			if s, _ := g[id]["inputs"].(map[string]any)["lora_name"].(string); strings.Contains(strings.ToLower(s), "turbo") || strings.Contains(strings.ToLower(s), "lightning") || strings.Contains(strings.ToLower(s), "step") {
				hasLightningLora = true
			}
		}
	}
	for id, n := range g {
		c := cls(id)
		if !strings.HasPrefix(c, "Primitive") {
			continue
		}
		key := id + ".value"
		for _, f := range cons[id] {
			// int feeding a step switch: which branch?
			if cls(f.node) == "ComfySwitchNode" && (f.input == "on_true" || f.input == "on_false") {
				for _, d := range feeds(f.node, 1) {
					if d.input == "steps" {
						if f.input == "on_true" {
							roles[key] = role{"Pasos (modo acelerado)", "Se usa al activar «Aceleración Lightning». El LoRA rápido está entrenado para 8 pasos (recomendado: 8)", 8, true}
						} else {
							roles[key] = role{"Pasos (modo normal)", "Se usa sin aceleración. Recomendación oficial: 20; menos de 20 puede verse borroso", 20, true}
						}
					}
				}
			}
			if cls(f.node) == "ComfySwitchNode" && f.input == "switch" && c == "PrimitiveBoolean" {
				lbl, hint := "Interruptor condicional", ""
				if hasLightningLora {
					lbl, hint = "Aceleración Lightning (LoRA de 8 pasos)", "Activado: ~2.5× más rápido con gran calidad; Desactivado: 20 pasos oficiales, máximo detalle pero más lento"
				}
				var rec any
				if hasLightningLora {
					rec = true // CU is precious on Colab: the 8-step LoRA is the best speed/quality trade-off
				}
				roles[key] = role{lbl, hint, rec, true}
			}
			if strings.HasPrefix(cls(f.node), "ComfyMathExpression") && c == "PrimitiveFloat" {
				for _, d := range cons[f.node] {
					if d.input == "length" || d.input == "num_frames" {
						roles[key] = role{"Duración del vídeo (segundos)", "H3 soporta de 4 a 15 s; a mayor duración, más tiempo y consumo de CU", 6.0, true}
					}
				}
			}
			if f.input == "steps" && c == "PrimitiveInt" {
				roles[key] = role{"Pasos de muestreo", inputCN["steps"].hint, nil, true}
			}
		}
		_ = n
	}
	// recommended values for well-known direct inputs
	for id, n := range g {
		in, _ := n["inputs"].(map[string]any)
		switch cls(id) {
		case "ResolutionSelector":
			if _, ok := in["megapixels"].(float64); ok {
				roles[id+".megapixels"] = role{"Megapíxeles totales", "0.98 ≈ 1344×768 (768p oficial, recomendado); 0.5 ≈ 960×544 más rápido", 0.98, true}
			}
		case "BasicScheduler":
			if _, ok := in["denoise"].(float64); ok {
				roles[id+".denoise"] = role{"Fuerza de redibujado (Denoise)", "En texto a vídeo mantener en 1", 1.0, false}
			}
		case "CreateVideo":
			if _, ok := in["fps"].(float64); ok {
				roles[id+".fps"] = role{"Fotogramas por segundo (FPS)", "H3 está entrenado a 24 FPS (recomendado: 24)", 24.0, true}
			}
		}
	}
	return roles
}

func translateTitle(t string) string {
	if t == "" {
		return t
	}
	t = strings.ReplaceAll(t, "正向提示词 (Positive Prompt)", "Prompt Positivo")
	t = strings.ReplaceAll(t, "正向提示词", "Prompt Positivo")
	t = strings.ReplaceAll(t, "反向提示词 (Negative Prompt)", "Prompt Negativo")
	t = strings.ReplaceAll(t, "反向提示词 negative", "Prompt Negativo (negative)")
	t = strings.ReplaceAll(t, "反向提示词", "Prompt Negativo")
	t = strings.ReplaceAll(t, "负面提示词 (Negative Prompt)", "Prompt Negativo")
	t = strings.ReplaceAll(t, "负面提示词", "Prompt Negativo")
	t = strings.ReplaceAll(t, "随机种子 (Seed)", "Semilla aleatoria")
	t = strings.ReplaceAll(t, "随机种子", "Semilla aleatoria")
	t = strings.ReplaceAll(t, "画布", "Lienzo")
	t = strings.ReplaceAll(t, "采样", "Muestreo")
	t = strings.ReplaceAll(t, "模型", "Modelo")
	t = strings.ReplaceAll(t, "解码", "Decodificador")
	t = strings.ReplaceAll(t, "保存图片", "Guardar imagen")
	t = strings.ReplaceAll(t, "写实生图", "Imagen fotorrealista")
	t = strings.ReplaceAll(t, "生图", "Generación de imagen")
	t = strings.ReplaceAll(t, "文生视频", "Texto a vídeo")
	t = strings.ReplaceAll(t, "对话", "Chat")
	t = strings.ReplaceAll(t, "文本提示词", "Prompt")
	t = strings.ReplaceAll(t, "参数配置", "Configuración")
	t = strings.ReplaceAll(t, "高清修复", "Auto-HD")
	return t
}

func nodeNameCN(n map[string]any) string {
	t := translateTitle(nodeTitle(n))
	cls, _ := n["class_type"].(string)
	if t == cls || t == "" {
		if cn, ok := classCN[cls]; ok {
			return cn
		}
	}
	return t
}
