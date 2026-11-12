package main

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultEURPerCU is the reference Google Colab Pay-As-You-Go price (~10 EUR per 100 CU = 0.10 EUR/CU).
const DefaultEURPerCU = 0.10

// usageRetentionDays keeps 90 days of session history as specified in ROADMAP.
const usageRetentionDays = 90

type UsageSession struct {
	ID          string  `json:"id"`
	StartedAt   int64   `json:"started_at"`
	EndedAt     int64   `json:"ended_at"`
	DurationSec int64   `json:"duration_s"`
	Profile     string  `json:"profile"`
	Accelerator string  `json:"accelerator"`
	RatePerHour float64 `json:"rate_per_hour"`
	BurnedCU    float64 `json:"burned_cu"`
	CostEUR     float64 `json:"cost_eur"`
	SavedCU     float64 `json:"saved_cu,omitempty"`
	SavedEUR    float64 `json:"saved_eur,omitempty"`
	StopReason  string  `json:"stop_reason,omitempty"`
}

type UsagePeriod struct {
	DurationSec int64   `json:"duration_s"`
	BurnedCU    float64 `json:"burned_cu"`
	CostEUR     float64 `json:"cost_eur"`
	Sessions    int     `json:"sessions"`
}

type UsageSummary struct {
	EURPerCU       float64        `json:"eur_per_cu"`
	Active         *UsageSession  `json:"active,omitempty"`
	Today          UsagePeriod    `json:"today"`
	Week           UsagePeriod    `json:"week"`
	Month          UsagePeriod    `json:"month"`
	TotalSavedCU   float64        `json:"total_saved_cu"`
	TotalSavedEUR  float64        `json:"total_saved_eur"`
	RecentSessions []UsageSession `json:"recent_sessions"`
}

var usageMu sync.Mutex

func usageFilePath() string {
	return filepath.Join(dataDir, "usage_history.json")
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func loadUsageSessions() []UsageSession {
	b, err := os.ReadFile(usageFilePath())
	if err != nil {
		return nil
	}
	var list []UsageSession
	_ = json.Unmarshal(b, &list)
	return list
}

func saveUsageSessions(list []UsageSession) {
	cutoff := time.Now().Add(-usageRetentionDays * 24 * time.Hour).Unix()
	kept := make([]UsageSession, 0, len(list))
	for _, s := range list {
		if s.EndedAt >= cutoff || s.StartedAt >= cutoff {
			kept = append(kept, s)
		}
	}
	writeJSON(usageFilePath(), kept)
}

// recordUsageSession persists a completed GPU session and calculates its CU & EUR consumption.
func recordUsageSession(startedAt, endedAt int64, profile, accel string, ratePerHour, measuredSpentCU float64, reason string) UsageSession {
	if endedAt <= 0 {
		endedAt = time.Now().Unix()
	}
	if startedAt <= 0 || endedAt < startedAt {
		startedAt = endedAt
	}
	dur := endedAt - startedAt
	if ratePerHour <= 0 {
		ratePerHour, _ = cuRate(accel)
		if ratePerHour <= 0 {
			ratePerHour = cuRateGuess["L4"]
		}
	}

	estCU := (float64(dur) / 3600.0) * ratePerHour
	burned := estCU
	if measuredSpentCU > burned {
		burned = measuredSpentCU
	}
	burned = round2(burned)
	cost := round2(burned * DefaultEURPerCU)

	// Calculate CU saved when Zero-Waste Watchdog stops the GPU early vs standard 30-min Colab idle timeout
	var savedCU float64
	if strings.Contains(reason, "Zero-Waste") {
		c := getConfig()
		zwIdle := c.ZeroWasteIdleSec
		if zwIdle <= 0 {
			zwIdle = 120
		}
		stdIdle := 30 * 60 // 1800s default Colab idle timeout
		if stdIdle > zwIdle {
			savedCU = round2((float64(stdIdle-zwIdle) / 3600.0) * ratePerHour)
		}
	}

	sess := UsageSession{
		ID:          newID(),
		StartedAt:   startedAt,
		EndedAt:     endedAt,
		DurationSec: dur,
		Profile:     profile,
		Accelerator: strings.ToUpper(strings.TrimSpace(accel)),
		RatePerHour: round2(ratePerHour),
		BurnedCU:    burned,
		CostEUR:     cost,
		SavedCU:     savedCU,
		SavedEUR:    round2(savedCU * DefaultEURPerCU),
		StopReason:  reason,
	}

	usageMu.Lock()
	defer usageMu.Unlock()
	list := loadUsageSessions()
	list = append(list, sess)
	saveUsageSessions(list)
	return sess
}

// activeLocalSession returns live consumption metrics if the local GPU is currently running.
func activeLocalSession() *UsageSession {
	if lg == nil {
		return nil
	}
	lg.mu.Lock()
	st := lg.state
	started := int64(lg.sessionStarted)
	prof := lg.profile
	acc := lg.accel
	startCU := lg.sessionStartCU
	var rate, curBal float64
	if lg.ccu != nil {
		rate = lg.ccu.RatePerHour
		curBal = lg.ccu.Balance
	}
	lg.mu.Unlock()

	if st == "" || st == "sleeping" || st == "failed" || started <= 0 {
		return nil
	}
	now := time.Now().Unix()
	dur := now - started
	if dur < 0 {
		dur = 0
	}
	if rate <= 0 {
		rate, _ = cuRate(acc)
		if rate <= 0 {
			rate = cuRateGuess["L4"]
		}
	}
	estCU := (float64(dur) / 3600.0) * rate
	var measured float64
	if startCU > 0 && curBal > 0 && startCU > curBal {
		measured = startCU - curBal
	}
	burned := estCU
	if measured > burned {
		burned = measured
	}
	burned = round2(burned)
	return &UsageSession{
		ID:          "active",
		StartedAt:   started,
		EndedAt:     now,
		DurationSec: dur,
		Profile:     prof,
		Accelerator: acc,
		RatePerHour: round2(rate),
		BurnedCU:    burned,
		CostEUR:     round2(burned * DefaultEURPerCU),
	}
}

func getUsageSummary() UsageSummary {
	usageMu.Lock()
	list := loadUsageSessions()
	usageMu.Unlock()

	now := time.Now()
	startOfToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).Unix()
	cutoff24h := now.Add(-24 * time.Hour).Unix()
	if cutoff24h < startOfToday {
		startOfToday = cutoff24h
	}
	cutoff7d := now.Add(-7 * 24 * time.Hour).Unix()
	cutoff30d := now.Add(-30 * 24 * time.Hour).Unix()

	sum := UsageSummary{
		EURPerCU:       DefaultEURPerCU,
		Active:         activeLocalSession(),
		RecentSessions: []UsageSession{},
	}

	addPeriod := func(p *UsagePeriod, s UsageSession) {
		p.DurationSec += s.DurationSec
		p.BurnedCU = round2(p.BurnedCU + s.BurnedCU)
		p.CostEUR = round2(p.CostEUR + s.CostEUR)
		p.Sessions++
	}

	for _, s := range list {
		if s.EndedAt >= startOfToday {
			addPeriod(&sum.Today, s)
		}
		if s.EndedAt >= cutoff7d {
			addPeriod(&sum.Week, s)
		}
		if s.EndedAt >= cutoff30d {
			addPeriod(&sum.Month, s)
		}
		sum.TotalSavedCU = round2(sum.TotalSavedCU + s.SavedCU)
		sum.TotalSavedEUR = round2(sum.TotalSavedEUR + s.SavedEUR)
	}

	// Include live active session in Today / Week / Month totals so the counters tick in real time
	if sum.Active != nil {
		addPeriod(&sum.Today, *sum.Active)
		addPeriod(&sum.Week, *sum.Active)
		addPeriod(&sum.Month, *sum.Active)
	}

	// Most recent 15 completed sessions first
	for i := len(list) - 1; i >= 0 && len(sum.RecentSessions) < 15; i-- {
		sum.RecentSessions = append(sum.RecentSessions, list[i])
	}

	return sum
}

func registerUsageRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /api/usage", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, http.StatusOK, getUsageSummary())
	})
	api.HandleFunc("POST /api/usage/clear", func(w http.ResponseWriter, r *http.Request) {
		usageMu.Lock()
		_ = os.Remove(usageFilePath())
		usageMu.Unlock()
		jsonOut(w, http.StatusOK, map[string]bool{"ok": true})
	})
}

