package main

import (
	"testing"
	"time"
)

func TestUsageTrackingAndSummary(t *testing.T) {
	withTempConfig(t, Config{ZeroWasteIdleSec: 120})

	now := time.Now().Unix()
	// 1. Sesión de 30 minutos en L4 (4.8 CU/h -> 2.40 CU -> 0.24 EUR), parada por Zero-Waste
	s1 := recordUsageSession(now-1800, now, "ai-realvisxl", "L4", 4.8, 0, "Zero-Waste Watchdog: inactividad de 120 s tras finalizar la cola")
	if s1.DurationSec != 1800 {
		t.Fatalf("esperaba 1800 s, obtuve %d", s1.DurationSec)
	}
	if s1.BurnedCU != 2.40 {
		t.Fatalf("esperaba 2.40 CU, obtuve %.2f", s1.BurnedCU)
	}
	if s1.CostEUR != 0.24 {
		t.Fatalf("esperaba 0.24 EUR, obtuve %.2f", s1.CostEUR)
	}
	// Ahorro Zero-Waste: (1800 - 120)s = 1680s a 4.8 CU/h = 2.24 CU
	if s1.SavedCU != 2.24 {
		t.Fatalf("esperaba 2.24 CU ahorradas por Zero-Waste, obtuve %.2f", s1.SavedCU)
	}

	// 2. Sesión de hace 3 días en G4 con caída real medida de 5.50 CU
	threeDaysAgo := now - 3*24*3600
	s2 := recordUsageSession(threeDaysAgo-1200, threeDaysAgo, "ai-chroma", "G4", 10.0, 5.50, "Parada manual")
	if s2.BurnedCU != 5.50 || s2.CostEUR != 0.55 {
		t.Fatalf("esperaba 5.50 CU (0.55 EUR), obtuve %.2f CU (%.2f EUR)", s2.BurnedCU, s2.CostEUR)
	}

	// 3. Resumen acumulado (Hoy vs 7 días vs 30 días)
	sum := getUsageSummary()
	if sum.Today.Sessions != 1 || sum.Today.BurnedCU != 2.40 || sum.Today.CostEUR != 0.24 {
		t.Fatalf("resumen Hoy inesperado: %+v", sum.Today)
	}
	if sum.Week.Sessions != 2 || sum.Week.BurnedCU != 7.90 || sum.Week.CostEUR != 0.79 {
		t.Fatalf("resumen 7d inesperado: %+v", sum.Week)
	}
	if sum.TotalSavedCU != 2.24 || sum.TotalSavedEUR != 0.22 {
		t.Fatalf("ahorro acumulado inesperado: %.2f CU (%.2f EUR)", sum.TotalSavedCU, sum.TotalSavedEUR)
	}
	if len(sum.RecentSessions) != 2 {
		t.Fatalf("esperaba 2 sesiones recientes, obtuve %d", len(sum.RecentSessions))
	}
}

