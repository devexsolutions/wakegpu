package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

type MobileStatus struct {
	Enabled       bool     `json:"enabled"`
	Port          int      `json:"port,omitempty"`
	LANURLs       []string `json:"lan_urls,omitempty"`
	PrimaryURL    string   `json:"primary_url,omitempty"`
	TunnelURL     string   `json:"tunnel_url,omitempty"`
	TunnelRunning bool     `json:"tunnel_running"`
	TunnelError   string   `json:"tunnel_error,omitempty"`
	QRSVG         string   `json:"qr_svg,omitempty"`
}

var (
	mobMu         sync.Mutex
	mobLn         net.Listener
	mobToken      string
	mobPort       int
	mobTunnelURL  string
	mobTunnelErr  string
	mobTunnelStop context.CancelFunc
)

func newMobileToken() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "m_" + hex.EncodeToString(b)
}

func isValidAPIKey(k string) bool {
	if k == "" {
		return false
	}
	if k == apiKey {
		return true
	}
	mobMu.Lock()
	mt := mobToken
	en := mobLn != nil
	mobMu.Unlock()
	return en && mt != "" && k == mt && IsPro()
}

func localLANIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var ips []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil {
				continue
			}
			ip4 := ip.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			ips = append(ips, ip4.String())
		}
	}
	return ips
}

func getMobileStatus() MobileStatus {
	mobMu.Lock()
	defer mobMu.Unlock()
	if mobLn == nil || mobToken == "" || !IsPro() {
		return MobileStatus{Enabled: false}
	}
	ips := localLANIPs()
	var urls []string
	for _, ip := range ips {
		urls = append(urls, fmt.Sprintf("http://%s:%d/?k=%s", ip, mobPort, mobToken))
	}
	if len(urls) == 0 {
		urls = append(urls, fmt.Sprintf("http://127.0.0.1:%d/?k=%s", mobPort, mobToken))
	}
	primary := urls[0]
	var tunFull string
	if mobTunnelURL != "" {
		tunFull = strings.TrimRight(mobTunnelURL, "/") + "/?k=" + mobToken
		primary = tunFull
	}
	return MobileStatus{
		Enabled:       true,
		Port:          mobPort,
		LANURLs:       urls,
		PrimaryURL:    primary,
		TunnelURL:     tunFull,
		TunnelRunning: mobTunnelStop != nil && mobTunnelURL != "",
		TunnelError:   mobTunnelErr,
		QRSVG:         generateQRSVG(primary),
	}
}

func startMobileServer(withTunnel bool) (MobileStatus, error) {
	if !IsPro() {
		return MobileStatus{}, errors.New("El Control Móvil (PWA + QR) es una función exclusiva de WakeGPU Pro.")
	}
	mobMu.Lock()
	if mobLn == nil {
		ln, err := net.Listen("tcp", "0.0.0.0:0")
		if err != nil {
			mobMu.Unlock()
			return MobileStatus{}, err
		}
		mobLn = ln
		mobPort = ln.Addr().(*net.TCPAddr).Port
		if mobToken == "" {
			mobToken = newMobileToken()
		}
		go http.Serve(ln, newServer())
	}
	port := mobPort
	if withTunnel && mobTunnelStop == nil {
		ctx, cancel := context.WithCancel(context.Background())
		mobTunnelStop = cancel
		mobTunnelURL = ""
		mobTunnelErr = ""
		go runCloudflaredTunnel(ctx, port)
	} else if !withTunnel && mobTunnelStop != nil {
		mobTunnelStop()
		mobTunnelStop = nil
		mobTunnelURL = ""
		mobTunnelErr = ""
	}
	mobMu.Unlock()
	if withTunnel {
		// Wait briefly up to 3.5s in case cloudflared outputs the URL quickly
		for i := 0; i < 14; i++ {
			mobMu.Lock()
			hasURL := mobTunnelURL != "" || mobTunnelErr != ""
			mobMu.Unlock()
			if hasURL {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	return getMobileStatus(), nil
}

func stopMobileServer() MobileStatus {
	mobMu.Lock()
	if mobTunnelStop != nil {
		mobTunnelStop()
		mobTunnelStop = nil
	}
	if mobLn != nil {
		_ = mobLn.Close()
		mobLn = nil
	}
	mobPort = 0
	mobTunnelURL = ""
	mobTunnelErr = ""
	mobMu.Unlock()
	return MobileStatus{Enabled: false}
}

var tryCFRegex = regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)

func runCloudflaredTunnel(ctx context.Context, port int) {
	bin, err := exec.LookPath("cloudflared")
	if err != nil {
		for _, p := range []string{"/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"} {
			if _, e := exec.LookPath(p); e == nil {
				bin = p
				break
			}
		}
	}
	if bin == "" {
		mobMu.Lock()
		mobTunnelErr = "cloudflared no instalado (modo Wi-Fi local activo). Para usar 4G/5G fuera de casa instala cloudflared: brew install cloudflared"
		mobTunnelStop = nil
		mobMu.Unlock()
		return
	}
	cmd := exec.CommandContext(ctx, bin, "tunnel", "--no-autoupdate", "--url", fmt.Sprintf("http://127.0.0.1:%d", port))
	stderr, err := cmd.StderrPipe()
	if err != nil {
		mobMu.Lock()
		mobTunnelErr = err.Error()
		mobTunnelStop = nil
		mobMu.Unlock()
		return
	}
	if err := cmd.Start(); err != nil {
		mobMu.Lock()
		mobTunnelErr = err.Error()
		mobTunnelStop = nil
		mobMu.Unlock()
		return
	}
	sc := bufio.NewScanner(stderr)
	for sc.Scan() {
		line := sc.Text()
		if m := tryCFRegex.FindString(line); m != "" {
			mobMu.Lock()
			mobTunnelURL = m
			mobMu.Unlock()
		}
	}
	_ = cmd.Wait()
}

func registerMobileRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /api/mobile/status", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, http.StatusOK, getMobileStatus())
	})
	api.HandleFunc("POST /api/mobile/start", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Tunnel bool `json:"tunnel"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		st, err := startMobileServer(in.Tunnel)
		if err != nil {
			errOut(w, http.StatusForbidden, err)
			return
		}
		jsonOut(w, http.StatusOK, st)
	})
	api.HandleFunc("POST /api/mobile/stop", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, http.StatusOK, stopMobileServer())
	})
	api.HandleFunc("POST /api/mobile/rotate", func(w http.ResponseWriter, r *http.Request) {
		if !IsPro() {
			errOut(w, http.StatusForbidden, errors.New("requiere WakeGPU Pro"))
			return
		}
		mobMu.Lock()
		mobToken = newMobileToken()
		mobMu.Unlock()
		jsonOut(w, http.StatusOK, getMobileStatus())
	})
}

// ---------- Compact ISO/IEC 18004 QR Code Generator (Byte mode, ECC Level L, Versions 1..6) ----------

type qrVersionSpec struct {
	version    int
	size       int
	dataBytes  int
	ecBytes    int
	alignCoord []int
	formatBits int // for ECC Level L (01) and Mask 0 (000) -> 01000 BCH
}

// Precomputed format info for ECC Level L (01) with Mask 0 (000): 0x77c4
const qrFormatLMask0 = 0x77c4

var qrSpecs = []qrVersionSpec{
	{1, 21, 19, 7, nil, qrFormatLMask0},
	{2, 25, 34, 10, []int{6, 18}, qrFormatLMask0},
	{3, 29, 55, 15, []int{6, 22}, qrFormatLMask0},
	{4, 33, 80, 20, []int{6, 26}, qrFormatLMask0},
	{5, 37, 108, 26, []int{6, 30}, qrFormatLMask0},
	{6, 41, 136, 18, []int{6, 34}, qrFormatLMask0}, // v6 uses 2 blocks of (68 data, 18 ec)
}

func generateQRSVG(text string) string {
	raw := []byte(text)
	var spec qrVersionSpec
	for _, s := range qrSpecs {
		if len(raw)+3 <= s.dataBytes {
			spec = s
			break
		}
	}
	if spec.version == 0 {
		return ""
	}

	// 1. Encode data bits (Byte mode = 0100)
	bits := make([]byte, 0, spec.dataBytes*8)
	appendBits := func(val, n int) {
		for i := n - 1; i >= 0; i-- {
			bits = append(bits, byte((val>>i)&1))
		}
	}
	appendBits(0b0100, 4)
	appendBits(len(raw), 8)
	for _, b := range raw {
		appendBits(int(b), 8)
	}
	for i := 0; i < 4 && len(bits) < spec.dataBytes*8; i++ {
		bits = append(bits, 0)
	}
	for len(bits)%8 != 0 {
		bits = append(bits, 0)
	}
	data := make([]byte, len(bits)/8)
	for i := range data {
		var v byte
		for b := 0; b < 8; b++ {
			v = (v << 1) | bits[i*8+b]
		}
		data[i] = v
	}
	pad := []byte{0xEC, 0x11}
	for i := 0; len(data) < spec.dataBytes; i++ {
		data = append(data, pad[i%2])
	}

	// 2. Reed-Solomon ECC
	var finalBytes []byte
	if spec.version < 6 {
		ec := rsEncode(data, spec.ecBytes)
		finalBytes = append(append([]byte{}, data...), ec...)
	} else {
		// Version 6-L has 2 blocks of 68 data codewords + 18 EC codewords each
		b1, b2 := data[:68], data[68:136]
		ec1, ec2 := rsEncode(b1, 18), rsEncode(b2, 18)
		for i := 0; i < 68; i++ {
			finalBytes = append(finalBytes, b1[i], b2[i])
		}
		for i := 0; i < 18; i++ {
			finalBytes = append(finalBytes, ec1[i], ec2[i])
		}
	}

	// 3. Build matrix
	n := spec.size
	mat := make([][]byte, n)
	reserved := make([][]bool, n)
	for i := range mat {
		mat[i] = make([]byte, n)
		reserved[i] = make([]bool, n)
	}

	setModule := func(r, c int, dark bool) {
		if r >= 0 && r < n && c >= 0 && c < n {
			if dark {
				mat[r][c] = 1
			}
			reserved[r][c] = true
		}
	}

	finder := func(row, col int) {
		for dr := -1; dr <= 7; dr++ {
			for dc := -1; dc <= 7; dc++ {
				dark := false
				if dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 {
					if dr == 0 || dr == 6 || dc == 0 || dc == 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) {
						dark = true
					}
				}
				setModule(row+dr, col+dc, dark)
			}
		}
	}
	finder(0, 0)
	finder(0, n-7)
	finder(n-7, 0)

	// Alignment patterns
	if len(spec.alignCoord) > 0 {
		for _, r := range spec.alignCoord {
			for _, c := range spec.alignCoord {
				if reserved[r][c] {
					continue
				}
				for dr := -2; dr <= 2; dr++ {
					for dc := -2; dc <= 2; dc++ {
						dark := dr == -2 || dr == 2 || dc == -2 || dc == 2 || (dr == 0 && dc == 0)
						setModule(r+dr, c+dc, dark)
					}
				}
			}
		}
	}

	// Timing patterns
	for i := 8; i < n-8; i++ {
		if !reserved[6][i] {
			setModule(6, i, i%2 == 0)
		}
		if !reserved[i][6] {
			setModule(i, 6, i%2 == 0)
		}
	}

	// Dark module & reserve format areas
	setModule(n-8, 8, true)
	for i := 0; i < 9; i++ {
		if i < 8 {
			reserved[8][n-1-i] = true
			reserved[n-1-i][8] = true
		}
		reserved[8][i] = true
		reserved[i][8] = true
	}

	// Place data bits upward/downward in 2-col strips
	bitIdx := 0
	totalBits := len(finalBytes) * 8
	up := true
	for col := n - 1; col > 0; col -= 2 {
		if col == 6 {
			col--
		}
		for i := 0; i < n; i++ {
			r := i
			if up {
				r = n - 1 - i
			}
			for dc := 0; dc < 2; dc++ {
				c := col - dc
				if reserved[r][c] {
					continue
				}
				var bit byte
				if bitIdx < totalBits {
					bit = (finalBytes[bitIdx/8] >> (7 - (bitIdx % 8))) & 1
					bitIdx++
				}
				// Apply Mask 0: (r + c) % 2 == 0
				if (r+c)%2 == 0 {
					bit ^= 1
				}
				mat[r][c] = bit
			}
		}
		up = !up
	}

	// Place Format Info bits for L + Mask 0 (qrFormatLMask0)
	for i := 0; i < 15; i++ {
		dark := ((qrFormatLMask0 >> i) & 1) == 1
		// Top-left
		if i < 6 {
			setModule(i, 8, dark)
		} else if i < 8 {
			setModule(i+1, 8, dark)
		} else if i == 8 {
			setModule(8, 7, dark)
		} else {
			setModule(8, 14-i, dark)
		}
		// Top-right & bottom-left
		if i < 8 {
			setModule(8, n-1-i, dark)
		} else {
			setModule(n-15+i, 8, dark)
		}
	}

	// Render compact SVG with explicit styles and attributes to prevent global CSS stroke inheritance
	margin := 3
	dim := n + margin*2
	var buf bytes.Buffer
	fmt.Fprintf(&buf, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges" style="stroke:none;fill:none"><rect width="%d" height="%d" fill="#ffffff" stroke="none" stroke-width="0"/><path fill="#000000" stroke="none" stroke-width="0" d="`, dim, dim, dim, dim)
	for r := 0; r < n; r++ {
		for c := 0; c < n; c++ {
			if mat[r][c] == 1 {
				fmt.Fprintf(&buf, "M%d,%dh1v1h-1z", c+margin, r+margin)
			}
		}
	}
	buf.WriteString(`"/></svg>`)
	return buf.String()
}

func rsEncode(data []byte, ecLen int) []byte {
	exp := make([]byte, 512)
	logT := make([]byte, 256)
	x := 1
	for i := 0; i < 255; i++ {
		exp[i] = byte(x)
		logT[x] = byte(i)
		x <<= 1
		if x&0x100 != 0 {
			x ^= 0x11d
		}
	}
	for i := 255; i < 512; i++ {
		exp[i] = exp[i-255]
	}
	mul := func(a, b byte) byte {
		if a == 0 || b == 0 {
			return 0
		}
		return exp[int(logT[a])+int(logT[b])]
	}
	gen := []byte{1}
	for i := 0; i < ecLen; i++ {
		next := make([]byte, len(gen)+1)
		for j := range gen {
			next[j] ^= gen[j]
			next[j+1] ^= mul(gen[j], exp[i])
		}
		gen = next
	}
	res := make([]byte, ecLen)
	for _, b := range data {
		factor := b ^ res[0]
		copy(res, res[1:])
		res[ecLen-1] = 0
		for j := 0; j < ecLen; j++ {
			res[j] ^= mul(gen[j+1], factor)
		}
	}
	return res
}
