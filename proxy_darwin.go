//go:build darwin

package main

import (
	"os/exec"
	"strings"
)

// systemProxy reads macOS system proxy settings via scutil --proxy.
func systemProxy() string {
	out, err := exec.Command("/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return ""
	}
	return parseScutilProxy(string(out))
}

func parseScutilProxy(raw string) string {
	kv := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	if kv["HTTPSEnable"] == "1" && kv["HTTPSProxy"] != "" {
		return hostPortURL("http://", kv["HTTPSProxy"], kv["HTTPSPort"])
	}
	if kv["HTTPEnable"] == "1" && kv["HTTPProxy"] != "" {
		return hostPortURL("http://", kv["HTTPProxy"], kv["HTTPPort"])
	}
	if kv["SOCKSEnable"] == "1" && kv["SOCKSProxy"] != "" {
		return hostPortURL("socks5://", kv["SOCKSProxy"], kv["SOCKSPort"])
	}
	return ""
}

func hostPortURL(scheme, host, port string) string {
	if port != "" && !strings.Contains(host, ":") {
		return scheme + host + ":" + port
	}
	return scheme + host
}

