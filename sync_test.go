package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCloudSyncGatingAndBackup(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "wl-sync-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	oldDataDir := dataDir
	dataDir = tmpDir
	defer func() { dataDir = oldDataDir }()

	_ = os.MkdirAll(filepath.Join(dataDir, "templates"), 0755)

	// 1. Ensure Free tier
	cfg := getConfig()
	cfg.LicenseKey = ""
	cfg.LicenseTier = "free"
	_ = saveConfig(cfg)

	// Export should return 403 Forbidden
	{
		req := httptest.NewRequest("GET", "/api/sync/export", nil)
		rec := httptest.NewRecorder()
		syncExportHandler(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden for sync export on Free tier, got %d", rec.Code)
		}
	}

	// Import should return 403 Forbidden
	{
		req := httptest.NewRequest("POST", "/api/sync/import", nil)
		rec := httptest.NewRecorder()
		syncImportHandler(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden for sync import on Free tier, got %d", rec.Code)
		}
	}

	// 2. Activate Pro tier
	cfg.LicenseKey = "WLPRO-DEMO-2026"
	cfg.LicenseTier = "pro"
	_ = saveConfig(cfg)

	// Create test template and prompt
	tpl := &Template{
		ID:      "sync-tpl-1",
		Name:    "Sync Workflow",
		Created: time.Now().Unix(),
		Graph: map[string]map[string]any{
			"1": {"class_type": "KSampler"},
		},
	}
	_ = saveTemplate(tpl)

	prompts := []map[string]any{
		{"name": "Masterpiece Portrait", "positive": "a beautiful portrait"},
	}
	_ = writeJSON(filepath.Join(dataDir, "prompts.json"), prompts)

	// Test Export on Pro tier
	var exportedBytes []byte
	{
		req := httptest.NewRequest("GET", "/api/sync/export", nil)
		rec := httptest.NewRecorder()
		syncExportHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK for sync export on Pro tier, got %d", rec.Code)
		}
		exportedBytes = rec.Body.Bytes()

		var bundle BackupBundle
		if err := json.Unmarshal(exportedBytes, &bundle); err != nil {
			t.Fatalf("failed to decode exported bundle: %v", err)
		}
		if len(bundle.Templates) == 0 {
			t.Errorf("expected at least 1 template in exported bundle")
		}
		if len(bundle.Prompts) == 0 {
			t.Errorf("expected at least 1 prompt in exported bundle")
		}
	}

	// Test Import on Pro tier into a clean workspace
	tmpDir2, _ := os.MkdirTemp("", "wl-sync-import-*")
	defer os.RemoveAll(tmpDir2)
	dataDir = tmpDir2
	_ = os.MkdirAll(filepath.Join(dataDir, "templates"), 0755)

	{
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, _ := writer.CreateFormFile("bundle", "backup.json")
		_, _ = part.Write(exportedBytes)
		_ = writer.Close()

		req := httptest.NewRequest("POST", "/api/sync/import", body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		rec := httptest.NewRecorder()

		syncImportHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK for sync import on Pro tier, got %d: %s", rec.Code, rec.Body.String())
		}

		// Verify templates were restored in new dataDir
		restoredTemplates := listTemplates()
		if len(restoredTemplates) != 1 {
			t.Errorf("expected 1 restored template, found %d", len(restoredTemplates))
		}

		// Verify prompts were restored in new dataDir
		restoredPrompts := loadPrompts()
		if len(restoredPrompts) != 1 {
			t.Errorf("expected 1 restored prompt, found %d", len(restoredPrompts))
		}
	}
}

