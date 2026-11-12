package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type mockTransport func(*http.Request) (*http.Response, error)

func (m mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return m(req)
}

func TestDiscordWebhookDispatch(t *testing.T) {
	received := false
	var receivedBody map[string]any

	client := &http.Client{
		Transport: mockTransport(func(req *http.Request) (*http.Response, error) {
			received = true
			b, _ := io.ReadAll(req.Body)
			_ = json.Unmarshal(b, &receivedBody)
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(bytes.NewReader(nil)),
				Header:     make(http.Header),
			}, nil
		}),
	}

	err := sendDiscordWebhook(client, "https://discord.com/api/webhooks/test", "job_done", "Test Title", "Job finished successfully in 45s")
	if err != nil {
		t.Fatalf("sendDiscordWebhook failed: %v", err)
	}

	if !received {
		t.Fatalf("expected webhook request to be made")
	}

	if receivedBody["username"] != "WakeGPU" {
		t.Errorf("expected username 'WakeGPU', got '%v'", receivedBody["username"])
	}

	embeds, ok := receivedBody["embeds"].([]any)
	if !ok || len(embeds) == 0 {
		t.Fatalf("expected embeds array in discord payload")
	}

	firstEmbed := embeds[0].(map[string]any)
	if firstEmbed["title"] != "✅ Test Title" {
		t.Errorf("expected title '✅ Test Title', got '%v'", firstEmbed["title"])
	}
}

func TestTelegramMessageDispatch(t *testing.T) {
	received := false
	var receivedBody map[string]any

	client := &http.Client{
		Transport: mockTransport(func(req *http.Request) (*http.Response, error) {
			received = true
			b, _ := io.ReadAll(req.Body)
			_ = json.Unmarshal(b, &receivedBody)
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"ok": true}`)),
				Header:     make(http.Header),
			}, nil
		}),
	}

	err := sendTelegramMessage(client, "dummy-token", "-100123456", "gpu_stop", "GPU Stopped", "Idle watchdog triggered")
	if err != nil {
		t.Fatalf("sendTelegramMessage failed: %v", err)
	}

	if !received {
		t.Fatalf("expected telegram request to be made")
	}

	if receivedBody["chat_id"] != "-100123456" {
		t.Errorf("expected chat_id '-100123456', got '%v'", receivedBody["chat_id"])
	}

	escaped := escapeTgMarkdown("Hello_World*Test`Code[Link")
	expected := "Hello\\_World\\*Test\\`Code\\[Link"
	if escaped != expected {
		t.Errorf("escapeTgMarkdown mismatch: got %q, want %q", escaped, expected)
	}
}

func TestNotifyEndpointGating(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "wl-notify-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	oldDataDir := dataDir
	dataDir = tmpDir
	defer func() { dataDir = oldDataDir }()

	// Mock notifyClient transport to avoid any real network calls
	oldTransport := notifyClient.Transport
	notifyClient.Transport = mockTransport(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"ok": true}`)),
			Header:     make(http.Header),
		}, nil
	})
	defer func() { notifyClient.Transport = oldTransport }()

	// 1. Free tier
	cfg := Config{LicenseTier: "free"}
	_ = saveConfig(cfg)

	body := bytes.NewReader([]byte(`{}`))
	req := httptest.NewRequest("POST", "/api/notify/test", body)
	rec := httptest.NewRecorder()

	notifyTestHandler(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden for notify test on Free tier, got %d", rec.Code)
	}

	// 2. Pro tier without channels
	cfg.LicenseKey = "WLPRO-DEMO-2026"
	cfg.LicenseTier = "pro"
	_ = saveConfig(cfg)

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/api/notify/test", bytes.NewReader([]byte(`{}`)))
	notifyTestHandler(rec2, req2)
	if rec2.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request (no channels configured) on Pro tier, got %d", rec2.Code)
	}

	// 3. Pro tier with configured Discord channel
	cfg.NotifyDiscordURL = "https://discord.com/api/webhooks/mock"
	_ = saveConfig(cfg)

	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest("POST", "/api/notify/test", bytes.NewReader([]byte(`{}`)))
	notifyTestHandler(rec3, req3)
	if rec3.Code != http.StatusOK {
		t.Errorf("expected 200 OK for notify test with mock channel on Pro tier, got %d: %s", rec3.Code, rec3.Body.String())
	}
}
