package main

import (
	"strings"
	"testing"
)

func TestBuildCommand_SFTP(t *testing.T) {
	tests := []struct {
		name     string
		homePath string
		wantDir  string // expected -d argument
	}{
		{"root homePath", "/", "/home"},
		{"subdirectory homePath", "/public_html", "/home/public_html"},
		{"nested subdirectory homePath", "/public_html/uploads", "/home/public_html/uploads"},
		{"empty homePath defaults to root", "", "/home"},
		{"trailing slash trimmed", "/public_html/", "/home/public_html"},
		{"leading-dot dir is valid", "/.well-known", "/home/.well-known"},
		{"traversal into .platform clamped", "/../.platform", "/home"},
		{"double traversal clamped", "/../../etc", "/home"},
		{"relative traversal clamped", "../../etc/passwd", "/home"},
		{"embedded traversal clamped", "/public_html/../../etc", "/home"},
		{"null byte clamped", "/pub\x00lic", "/home"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildCommand("sftp", nil, tt.homePath)
			// Must be direct argument array, NOT sh -c (prevents shell injection)
			if got[0] == "sh" {
				t.Fatal("SFTP must not use sh -c — use sftp-chroot binary directly")
			}
			if got[0] != "sftp-chroot" {
				t.Fatalf("expected sftp-chroot, got %q", got[0])
			}
			// Chroot into /jail; the PVC is mounted at /jail/home by the pod
			// spec, so there is NO runtime --bind (that needed CAP_SYS_ADMIN).
			assertContains(t, got, "--root")
			assertContains(t, got, "/jail")
			for _, a := range got {
				if a == "--bind" {
					t.Error("sftp command must not use --bind (no runtime mount)")
				}
			}
			// Check -d flag value
			for i, arg := range got {
				if arg == "-d" && i+1 < len(got) {
					if got[i+1] != tt.wantDir {
						t.Errorf("-d = %q, want %q", got[i+1], tt.wantDir)
					}
					return
				}
			}
			t.Error("missing -d flag in command")
		})
	}
}

func TestConfineHome(t *testing.T) {
	tests := []struct {
		name     string
		homePath string
		want     string
	}{
		{"root", "/", "/home"},
		{"empty", "", "/home"},
		{"subdir", "/public_html", "/home/public_html"},
		{"subdir no leading slash", "public_html", "/home/public_html"},
		{"nested", "/public_html/uploads", "/home/public_html/uploads"},
		{"trailing slash", "/public_html/", "/home/public_html"},
		{"dot component collapsed", "/public_html/./img", "/home/public_html/img"},
		{"double slash collapsed", "/public_html//img", "/home/public_html/img"},
		{"leading-dot dir kept", "/.well-known", "/home/.well-known"},
		{"triple-dot dir kept", "/.../weird", "/home/.../weird"},
		{"leading traversal clamped", "/../.platform", "/home"},
		{"double traversal clamped", "/../../etc", "/home"},
		{"relative traversal clamped", "../../etc/passwd", "/home"},
		{"embedded traversal clamped", "/public_html/../../etc", "/home"},
		{"lone dotdot clamped", "..", "/home"},
		{"null byte clamped", "/pub\x00lic", "/home"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := confineHome(tt.homePath)
			if got != tt.want {
				t.Errorf("confineHome(%q) = %q, want %q", tt.homePath, got, tt.want)
			}
			// Invariant: the start dir can never escape the PVC mount at /home.
			if got != "/home" && !strings.HasPrefix(got, "/home/") {
				t.Errorf("confineHome(%q) = %q escapes /home", tt.homePath, got)
			}
		})
	}
}

func assertContains(t *testing.T, args []string, want string) {
	t.Helper()
	for _, a := range args {
		if a == want || strings.Contains(a, want) {
			return
		}
	}
	t.Errorf("args %v should contain %q", args, want)
}

func TestBuildCommand_SCP(t *testing.T) {
	cmd := "scp -t /upload/file.txt"
	got := buildCommand("scp", &cmd, "/")
	// SCP should still use path rewriting (not chroot)
	if got[0] != "scp" {
		t.Errorf("SCP command should start with 'scp', got %q", got[0])
	}
	// Path should be rewritten under /data
	found := false
	for _, arg := range got {
		if arg == "/data/upload/file.txt" {
			found = true
		}
	}
	if !found {
		t.Errorf("SCP path not rewritten under /data, got %v", got)
	}
}

func TestBuildCommand_Rsync(t *testing.T) {
	cmd := "rsync --server -logDtpre.iLsfxCIvu . /some/path"
	got := buildCommand("rsync", &cmd, "/")
	// Path after "." should be rewritten under /data
	found := false
	for _, arg := range got {
		if arg == "/data/some/path" {
			found = true
		}
	}
	if !found {
		t.Errorf("rsync path not rewritten under /data, got %v", got)
	}
}

func TestBuildCommand_Unknown(t *testing.T) {
	got := buildCommand("unknown", nil, "/")
	if got != nil {
		t.Errorf("unknown protocol should return nil, got %v", got)
	}
}

func TestSanitizePath(t *testing.T) {
	tests := []struct {
		name     string
		arg      string
		dataRoot string
		want     string
	}{
		{"normal path", "/file.txt", "/data", "/data/file.txt"},
		{"traversal attempt", "../../etc/passwd", "/data", "/data/etc/passwd"},
		{"double slash", "//etc/passwd", "/data", "/data/etc/passwd"},
		{"null byte", "file\x00.txt", "/data", "/data"},
		{"root escape", "/", "/data", "/data"},
		{"subdir", "/sub/dir/file.txt", "/data/home", "/data/home/sub/dir/file.txt"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizePath(tt.arg, tt.dataRoot)
			if got != tt.want {
				t.Errorf("sanitizePath(%q, %q) = %q, want %q", tt.arg, tt.dataRoot, got, tt.want)
			}
		})
	}
}
