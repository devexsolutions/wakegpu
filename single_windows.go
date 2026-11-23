//go:build windows

package main

import (
	"os"
	"syscall"
	"time"
	"unsafe"
)

// ensureSingleInstance stops a second copy of the workbench: two copies share the same job
// queue on disk, so both would pick up (and download, or even submit) the same jobs.
// Right after a self-update the old process may still be exiting, so wait for it briefly.
func ensureSingleInstance() {
	k32 := syscall.NewLazyDLL("kernel32.dll")
	create, closeH := k32.NewProc("CreateMutexW"), k32.NewProc("CloseHandle")
	name, _ := syscall.UTF16PtrFromString("Local\\ComfyColabWorkbench.single")
	tries := 1
	if os.Getenv("CKWB_UPDATED") != "" {
		tries = 40
	}
	for i := 0; i < tries; i++ {
		h, _, err := create.Call(0, 0, uintptr(unsafe.Pointer(name)))
		if h != 0 && err != syscall.Errno(183) { // not ERROR_ALREADY_EXISTS: we own it
			return
		}
		if h != 0 {
			closeH.Call(h)
		}
		time.Sleep(500 * time.Millisecond)
	}
	fatal("WakeGPU ya está en ejecución (puede estar en la barra de tareas).\n\nAbrir dos instancias procesaría las mismas tareas por duplicado.\nSi no ves la ventana, finaliza WakeGPU en el Administrador de tareas.")
}
