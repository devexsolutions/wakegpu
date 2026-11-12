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

func TestProBatchAndAutoHiresGating(t *testing.T) {
	// Setup temporary data directory
	tmpDir, err := os.MkdirTemp("", "wl-pro-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	oldDataDir := dataDir
	dataDir = tmpDir
	defer func() { dataDir = oldDataDir }()

	_ = os.MkdirAll(filepath.Join(dataDir, "templates"), 0755)
	_ = os.MkdirAll(filepath.Join(dataDir, "uploads"), 0755)

	// Create a dummy template
	dummyTpl := &Template{
		ID:      "tpl-test-1",
		Name:    "Workflow Test",
		Created: time.Now().Unix(),
		Graph: map[string]map[string]any{
			"1": {"class_type": "KSampler", "inputs": map[string]any{"seed": 123}},
		},
	}
	if err := saveTemplate(dummyTpl); err != nil {
		t.Fatalf("failed to save template: %v", err)
	}

	// 1. Ensure Free tier (empty license)
	cfg := getConfig()
	cfg.LicenseKey = ""
	cfg.LicenseTier = "free"
	cfg.LicenseExpires = 0
	_ = saveConfig(cfg)

	if IsPro() {
		t.Fatalf("expected Free tier, got Pro")
	}

	// Test 1a: Attempt Count = 3 on Free tier -> should return 403
	{
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		specJSON := `{"template_id":"tpl-test-1","count":3,"title":"Batch Test"}`
		_ = writer.WriteField("spec", specJSON)
		_ = writer.Close()

		req := httptest.NewRequest("POST", "/api/jobs", body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		rec := httptest.NewRecorder()

		createJob(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden for batch > 1 on Free tier, got %d: %s", rec.Code, rec.Body.String())
		}
	}

	// Test 1b: Attempt AutoHires on Free tier -> should return 403
	{
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		specJSON := `{"template_id":"tpl-test-1","count":1,"draft":true,"auto_hires":true,"title":"AutoHires Test"}`
		_ = writer.WriteField("spec", specJSON)
		_ = writer.Close()

		req := httptest.NewRequest("POST", "/api/jobs", body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		rec := httptest.NewRecorder()

		createJob(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden for auto_hires on Free tier, got %d: %s", rec.Code, rec.Body.String())
		}
	}

	// Test 1c: Single standard job on Free tier -> should succeed (200)
	{
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		specJSON := `{"template_id":"tpl-test-1","count":1,"title":"Single Free Job"}`
		_ = writer.WriteField("spec", specJSON)
		_ = writer.Close()

		req := httptest.NewRequest("POST", "/api/jobs", body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		rec := httptest.NewRecorder()

		createJob(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("expected 200 OK for single job on Free tier, got %d: %s", rec.Code, rec.Body.String())
		}
	}

	// 2. Activate Pro tier via demo key
	cfg = getConfig()
	cfg.LicenseKey = "WLPRO-DEMO-2026"
	cfg.LicenseTier = "pro"
	cfg.LicenseExpires = 0
	_ = saveConfig(cfg)

	if !IsPro() {
		t.Fatalf("expected Pro tier after activation")
	}

	// Test 2a: Batch count = 3 on Pro tier -> should succeed with 3 job IDs
	{
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		specJSON := `{"template_id":"tpl-test-1","count":3,"title":"Batch Pro Run"}`
		_ = writer.WriteField("spec", specJSON)
		_ = writer.Close()

		req := httptest.NewRequest("POST", "/api/jobs", body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		rec := httptest.NewRecorder()

		createJob(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK for batch run on Pro tier, got %d: %s", rec.Code, rec.Body.String())
		}

		var res struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if len(res.IDs) != 3 {
			t.Errorf("expected 3 jobs created, got %d", len(res.IDs))
		}

		// Verify job titles in store
		j0 := store.get(res.IDs[0])
		if j0 == nil || j0.Title != "Batch Pro Run (1/3)" {
			t.Errorf("expected job 0 title 'Batch Pro Run (1/3)', got '%v'", j0)
		}
		j2 := store.get(res.IDs[2])
		if j2 == nil || j2.Title != "Batch Pro Run (3/3)" {
			t.Errorf("expected job 2 title 'Batch Pro Run (3/3)', got '%v'", j2)
		}
	}

	// Test 2b: AutoHires queueing
	{
		draftJob := &Job{
			ID:           "job-draft-001",
			TemplateID:   "tpl-test-1",
			TemplateName: "Workflow Test",
			Title:        "Paisaje · Borrador",
			Status:       "done",
			Draft:        true,
			AutoHires:    true,
			FullRes:      "1920x1080",
			UsedSeeds:    map[string]int64{"1.seed": 998877},
			Created:      time.Now().Unix(),
		}
		store.add(draftJob)

		hiresJob, err := queueHiresJob(draftJob)
		if err != nil {
			t.Fatalf("queueHiresJob failed: %v", err)
		}
		if hiresJob.ParentID != "job-draft-001" {
			t.Errorf("expected ParentID 'job-draft-001', got '%s'", hiresJob.ParentID)
		}
		if hiresJob.FullRes != "1920x1080" {
			t.Errorf("expected FullRes '1920x1080', got '%s'", hiresJob.FullRes)
		}
		if hiresJob.Title != "Paisaje · HD" {
			t.Errorf("expected Title 'Paisaje · HD', got '%s'", hiresJob.Title)
		}
		if hiresJob.Values["1.seed"] != int64(998877) {
			t.Errorf("expected seed 998877 locked in hires job, got %v", hiresJob.Values["1.seed"])
		}
	}
}
