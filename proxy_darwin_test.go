//go:build darwin

package main

import "testing"

func TestParseScutilProxy(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "no proxy",
			raw: `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  FTPPassive : 1
}`,
			want: "",
		},
		{
			name: "https proxy enabled",
			raw: `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}`,
			want: "http://127.0.0.1:7891",
		},
		{
			name: "http proxy only",
			raw: `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
}`,
			want: "http://127.0.0.1:8080",
		},
		{
			name: "socks proxy only",
			raw: `<dictionary> {
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}`,
			want: "socks5://127.0.0.1:1080",
		},
	}
	for _, tc := range cases {
		if got := parseScutilProxy(tc.raw); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

