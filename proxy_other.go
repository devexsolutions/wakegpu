//go:build !windows && !darwin

package main

func systemProxy() string { return "" }

