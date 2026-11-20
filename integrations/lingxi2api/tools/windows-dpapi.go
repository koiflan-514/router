package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	crypt32            = syscall.NewLazyDLL("crypt32.dll")
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	procUnprotect      = crypt32.NewProc("CryptUnprotectData")
	procLocalFree      = kernel32.NewProc("LocalFree")
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

func newBlob(d []byte) *dataBlob {
	if len(d) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{uint32(len(d)), &d[0]}
}

func (b *dataBlob) bytes() []byte {
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}

func unprotect(in []byte) ([]byte, error) {
	inBlob := newBlob(in)
	var outBlob dataBlob
	r, _, err := procUnprotect.Call(
		uintptr(unsafe.Pointer(inBlob)), 0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&outBlob)))
	if r == 0 {
		return nil, fmt.Errorf("CryptUnprotectData: %v", err)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(outBlob.pbData)))
	return outBlob.bytes(), nil
}

func main() {
	// 入参：Local State 路径。输出：32 字节密钥的 base64（一行）
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dpapihelper <Local State path>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(1)
	}
	var state struct {
		OSCrypt struct {
			EncryptedKey string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(1)
	}
	if state.OSCrypt.EncryptedKey == "" {
		fmt.Fprintln(os.Stderr, "no os_crypt.encrypted_key")
		os.Exit(1)
	}
	blob, err := base64.StdEncoding.DecodeString(state.OSCrypt.EncryptedKey)
	if err != nil {
		fmt.Fprintln(os.Stderr, "b64:", err)
		os.Exit(1)
	}
	if len(blob) > 5 && string(blob[:5]) == "DPAPI" {
		blob = blob[5:]
	}
	key, err := unprotect(blob)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(key) != 32 {
		fmt.Fprintf(os.Stderr, "key length %d, want 32\n", len(key))
		os.Exit(1)
	}
	fmt.Println(base64.StdEncoding.EncodeToString(key))
}
