package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"time"
)

type BackupBundle struct {
	Version    string           `json:"version"`
	ExportedAt int64            `json:"exported_at"`
	Prompts    []map[string]any `json:"prompts"`
	Templates  []*Template      `json:"templates"`
}

// syncExportHandler exports all user prompts and templates in a portable JSON bundle.
func syncExportHandler(w http.ResponseWriter, r *http.Request) {
	if !IsPro() {
		errOut(w, 403, errors.New("La exportación y sincronización en la nube requieren una licencia WakeGPU Pro activa."))
		return
	}

	var fullTemplates []*Template
	for _, t := range listTemplates() {
		if full, err := loadTemplate(t.ID); err == nil {
			fullTemplates = append(fullTemplates, full)
		}
	}

	bundle := BackupBundle{
		Version:    AppVersion,
		ExportedAt: time.Now().Unix(),
		Prompts:    loadPrompts(),
		Templates:  fullTemplates,
	}

	filename := fmt.Sprintf("wakegpu-backup-%s.json", time.Now().Format("2006-01-02-150405"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(bundle)
}

// syncImportHandler imports and merges a backup JSON bundle into the local workspace.
func syncImportHandler(w http.ResponseWriter, r *http.Request) {
	if !IsPro() {
		errOut(w, 403, errors.New("La importación y sincronización en la nube requieren una licencia WakeGPU Pro activa."))
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		errOut(w, 400, err)
		return
	}

	file, _, err := r.FormFile("bundle")
	if err != nil {
		errOut(w, 400, errors.New("Archivo de copia de seguridad no proporcionado"))
		return
	}
	defer file.Close()

	var bundle BackupBundle
	if err := json.NewDecoder(file).Decode(&bundle); err != nil {
		errOut(w, 400, errors.New("El archivo no tiene un formato de respaldo de WakeGPU válido"))
		return
	}

	// 1. Restore templates
	restoredTemplates := 0
	for _, tpl := range bundle.Templates {
		if tpl == nil || tpl.Name == "" || len(tpl.Graph) == 0 {
			continue
		}
		// If ID is missing, saveTemplate generates one
		if err := saveTemplate(tpl); err == nil {
			restoredTemplates++
		}
	}

	// 2. Restore prompts (merge avoiding duplicates by name)
	existing := loadPrompts()
	existingNames := map[string]bool{}
	for _, p := range existing {
		if name, ok := p["name"].(string); ok {
			existingNames[name] = true
		}
	}

	restoredPrompts := 0
	for _, p := range bundle.Prompts {
		name, _ := p["name"].(string)
		if name == "" {
			name = "Prompt importado"
			p["name"] = name
		}
		if !existingNames[name] {
			existing = append(existing, p)
			existingNames[name] = true
			restoredPrompts++
		}
	}

	if len(existing) > 0 {
		_ = writeJSON(filepath.Join(dataDir, "prompts.json"), existing)
	}

	jsonOut(w, 200, map[string]any{
		"ok":                 true,
		"restored_templates": restoredTemplates,
		"restored_prompts":   restoredPrompts,
		"message": fmt.Sprintf("Importación completada: %d plantillas y %d prompts restaurados.",
			restoredTemplates, restoredPrompts),
	})
}

