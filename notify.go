package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// notifyClient is used for outgoing webhooks to avoid hanging
var notifyClient = &http.Client{
	Timeout: 10 * time.Second,
}

// sendNotification dispatches an event notification to Discord and/or Telegram if Pro is active.
func sendNotification(event, title, message string) {
	if !IsPro() {
		return
	}
	c := getConfig()

	switch event {
	case "job_done":
		if !c.NotifyOnJobDone {
			return
		}
	case "job_failed":
		if !c.NotifyOnJobFailed {
			return
		}
	case "gpu_stop":
		if !c.NotifyOnGPUStop {
			return
		}
	}

	if c.NotifyDiscordURL != "" {
		go func(url, ev, t, m string) {
			_ = sendDiscordWebhook(notifyClient, url, ev, t, m)
		}(c.NotifyDiscordURL, event, title, message)
	}

	if c.NotifyTelegramToken != "" && c.NotifyTelegramChat != "" {
		go func(tok, chat, ev, t, m string) {
			_ = sendTelegramMessage(notifyClient, tok, chat, ev, t, m)
		}(c.NotifyTelegramToken, c.NotifyTelegramChat, event, title, message)
	}
}

// sendDiscordWebhook sends a formatted embed message to a Discord webhook URL.
func sendDiscordWebhook(client *http.Client, webhookURL, event, title, message string) error {
	if client == nil {
		client = notifyClient
	}
	color := 0x10B981 // Green (done)
	icon := "✅"
	switch event {
	case "job_failed":
		color = 0xEF4444 // Red
		icon = "❌"
	case "gpu_stop":
		color = 0xF59E0B // Amber
		icon = "⏹️"
	case "test":
		color = 0x3B82F6 // Blue
		icon = "🔔"
	}

	payload := map[string]any{
		"username":   "WakeGPU",
		"avatar_url": "https://raw.githubusercontent.com/devexsolutions/wakegpu/main/winres/icon.png",
		"embeds": []map[string]any{
			{
				"title":       fmt.Sprintf("%s %s", icon, title),
				"description": message,
				"color":       color,
				"footer": map[string]string{
					"text": "WakeGPU · Zero-Waste Guard",
				},
				"timestamp": time.Now().UTC().Format(time.RFC3339),
			},
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("discord webhook status %d", res.StatusCode)
	}
	return nil
}

// sendTelegramMessage sends a Markdown message to a Telegram chat via Bot API.
func sendTelegramMessage(client *http.Client, botToken, chatID, event, title, message string) error {
	if client == nil {
		client = notifyClient
	}

	icon := "✅"
	switch event {
	case "job_failed":
		icon = "❌"
	case "gpu_stop":
		icon = "⏹️"
	case "test":
		icon = "🔔"
	}

	text := fmt.Sprintf("%s *%s*\n\n%s\n\n_WakeGPU Guard_", icon, escapeTgMarkdown(title), escapeTgMarkdown(message))

	payload := map[string]any{
		"chat_id":    chatID,
		"text":       text,
		"parse_mode": "Markdown",
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	apiURL := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", botToken)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", apiURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("telegram bot status %d", res.StatusCode)
	}
	return nil
}

func escapeTgMarkdown(s string) string {
	r := strings.NewReplacer(
		"_", "\\_",
		"*", "\\*",
		"`", "\\`",
		"[", "\\[",
	)
	return r.Replace(s)
}

// notifyTestHandler handles POST /api/notify/test
func notifyTestHandler(w http.ResponseWriter, r *http.Request) {
	if !IsPro() {
		errOut(w, 403, errors.New("Las notificaciones remotas requieren una licencia WakeGPU Pro activa."))
		return
	}

	var in struct {
		Target string `json:"target"` // "discord", "telegram", or "" (both)
	}
	_ = json.NewDecoder(r.Body).Decode(&in)

	c := getConfig()
	tested := 0
	var errs []string

	if (in.Target == "" || in.Target == "discord") && c.NotifyDiscordURL != "" {
		tested++
		if err := sendDiscordWebhook(notifyClient, c.NotifyDiscordURL, "test", "Prueba de notificación", "¡Conexión con Discord configurada correctamente desde WakeGPU!"); err != nil {
			errs = append(errs, "Discord: "+err.Error())
		}
	}

	if (in.Target == "" || in.Target == "telegram") && c.NotifyTelegramToken != "" && c.NotifyTelegramChat != "" {
		tested++
		if err := sendTelegramMessage(notifyClient, c.NotifyTelegramToken, c.NotifyTelegramChat, "test", "Prueba de notificación", "¡Conexión con Telegram Bot configurada correctamente desde WakeGPU!"); err != nil {
			errs = append(errs, "Telegram: "+err.Error())
		}
	}

	if tested == 0 {
		errOut(w, 400, errors.New("No hay ningún canal de notificación configurado (indica una URL de Discord o Token + Chat ID de Telegram)"))
		return
	}

	if len(errs) > 0 {
		jsonOut(w, 502, map[string]any{
			"ok":    false,
			"error": strings.Join(errs, " | "),
		})
		return
	}

	jsonOut(w, 200, map[string]any{
		"ok":      true,
		"message": "Notificación de prueba enviada con éxito.",
	})
}

