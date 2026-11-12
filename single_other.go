//go:build !windows

package main

import (
	"net"
	"os"
	"time"
)

var singleLn net.Listener

func ensureSingleInstance() {
	tries := 1
	if os.Getenv("CKWB_UPDATED") != "" {
		tries = 40
	}
	var err error
	for i := 0; i < tries; i++ {
		singleLn, err = net.Listen("tcp", "127.0.0.1:47819")
		if err == nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	fatal("WakeGPU ya está en ejecución.")
}
