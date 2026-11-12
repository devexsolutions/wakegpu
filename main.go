package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	if os.Getenv("CKWB_HEADLESS") == "" {
		ensureSingleInstance()
	}
	initDataDir()
	hadConfig := configExisted()
	lf, _ := os.OpenFile(filepath.Join(dataDir, "workbench.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if lf != nil {
		log.SetOutput(lf)
	}
	loadConfig()
	if licenseSecret == "" {
		fatal("Secreto de licencia no configurado. Compila con -X main.licenseSecret=$WL_LICENSE_SECRET o exporta WL_LICENSE_SECRET (ver docs/LICENCIAS.md).")
	}
	loadGoogleToken()
	migrateOnboarding(hadConfig)
	store.load()
	startLocalGate()
	go cleanupOldExe()
	go worker()
	go ud.loop()
	go licenseValidationLoop()

	addr := "127.0.0.1:0"
	if p := os.Getenv("CKWB_PORT"); p != "" {
		addr = "127.0.0.1:" + p
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fatal("No se pudo iniciar el servicio local: " + err.Error())
	}
	go http.Serve(ln, newServer())
	url := fmt.Sprintf("http://%s/?k=%s", ln.Addr().String(), apiKey)
	log.Println("workbench at", url)
	if os.Getenv("CKWB_HEADLESS") != "" {
		fmt.Println(url)
		select {}
	}
	runWindow(url)
}
