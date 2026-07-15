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
		{"root homePath", "/", "/"},
		{"subdirectory homePath", "/public_html", "/public_html"},
		{"nested subdirectory homePath", "/public_html/uploads", "/public_html/uploads"},
		{"empty homePath defaults to root", "", "/"},
		{"trailing slash trimmed", "/public_html/", "/public_html"},
		{"leading-dot dir is valid", "/.well-known", "/.well-known"},
		{"leading traversal clamped", "/../etc", "/"},
		{"double traversal clamped", "/../../etc", "/"},
		{"relative traversal clamped", "../../etc/passwd", "/"},
		{"embedded traversal clamped", "/public_html/../../etc", "/"},
		{"null byte clamped", "/pub\x00lic", "/"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildCommand("sftp", nil, tt.homePath)
			// Must be a direct argument array, NOT sh -c (prevents shell injection)
			if got[0] == "sh" {
				t.Fatal("SFTP must not use sh -c — use the sftp-serve binary directly")
			}
			if got[0] != "sftp-serve" {
				t.Fatalf("expected sftp-serve, got %q", got[0])
			}
			// Chroot root is the tenant PVC mount itself — there is no /jail and
			// no runtime --bind (that would need CAP_SYS_ADMIN).
			assertContains(t, got, "--root")
			assertContains(t, got, "/data")
			for _, a := range got {
				if a == "--bind" {
					t.Error("sftp command must not use --bind (no runtime mount)")
				}
				if a == "/jail" || strings.Contains(a, ".platform") {
					t.Errorf("sftp command must not reference the retired jail scaffolding: %q", a)
				}
			}
			// --home is the ENFORCED scope: sftp-serve chroots into root+home.
			for i, arg := range got {
				if arg == "--home" && i+1 < len(got) {
					if got[i+1] != tt.wantDir {
						t.Errorf("--home = %q, want %q", got[i+1], tt.wantDir)
					}
					return
				}
			}
			t.Error("missing --home flag in command")
		})
	}
}

func TestConfineHome(t *testing.T) {
	tests := []struct {
		name     string
		homePath string
		want     string
	}{
		{"root", "/", "/"},
		{"empty", "", "/"},
		{"subdir", "/public_html", "/public_html"},
		{"subdir no leading slash", "public_html", "/public_html"},
		{"nested", "/public_html/uploads", "/public_html/uploads"},
		{"trailing slash", "/public_html/", "/public_html"},
		{"dot component collapsed", "/public_html/./img", "/public_html/img"},
		{"double slash collapsed", "/public_html//img", "/public_html/img"},
		{"leading-dot dir kept", "/.well-known", "/.well-known"},
		{"triple-dot dir kept", "/.../weird", "/.../weird"},
		{"leading traversal clamped", "/../etc", "/"},
		{"double traversal clamped", "/../../etc", "/"},
		{"relative traversal clamped", "../../etc/passwd", "/"},
		{"embedded traversal clamped", "/public_html/../../etc", "/"},
		{"lone dotdot clamped", "..", "/"},
		{"null byte clamped", "/pub\x00lic", "/"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := confineHome(tt.homePath)
			if got != tt.want {
				t.Errorf("confineHome(%q) = %q, want %q", tt.homePath, got, tt.want)
			}
			// Invariant: the scope is always PVC-root-relative and can never
			// climb out. Check ".." as a path COMPONENT, not a substring — a
			// directory legitimately named "..." contains ".." and must pass.
			// (sftp-serve additionally resolves the result with
			// openat2(RESOLVE_BENEATH), which is the real guarantee — this is
			// defence in depth.)
			if !strings.HasPrefix(got, "/") {
				t.Errorf("confineHome(%q) = %q is not PVC-root-relative", tt.homePath, got)
			}
			for _, part := range strings.Split(got, "/") {
				if part == ".." {
					t.Errorf("confineHome(%q) = %q escapes the PVC root", tt.homePath, got)
				}
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

// TestRewriteRsyncCommand_NoDotSeparator is the regression test for the
// confinement gap where rsync paths were only sanitized AFTER a literal "."
// token. A crafted server command that omits "." must still have every
// path argument confined under dataRoot — rsync runs unchrooted as root, so
// this rewrite is the only boundary.
func TestRewriteRsyncCommand_NoDotSeparator(t *testing.T) {
	tests := []struct {
		name string
		cmd  string
		// a path that MUST appear (confined) and one that MUST NOT (raw escape)
		mustContain string
		mustNotHave string
	}{
		{
			name:        "no dot, absolute escape",
			cmd:         "rsync --server --sender -e.LsfxC /etc/shadow",
			mustContain: "/data/etc/shadow",
			mustNotHave: "/etc/shadow",
		},
		{
			name:        "no dot, traversal",
			cmd:         "rsync --server -logDtpre.iLsfxC ../../etc/passwd",
			mustContain: "/data/etc/passwd",
			mustNotHave: "../../etc/passwd",
		},
		{
			name:        "with dot still confined",
			cmd:         "rsync --server -logDtpre.iLsfxCIvu . /some/path",
			mustContain: "/data/some/path",
			mustNotHave: "",
		},
		{
			name:        "embedded path in --files-from= flag",
			cmd:         "rsync --server --files-from=/etc/shadow . /dest",
			mustContain: "--files-from=/data/etc/shadow",
			mustNotHave: "--files-from=/etc/shadow",
		},
		{
			name:        "embedded path in --log-file= flag",
			cmd:         "rsync --server --log-file=../../var/log/x -e.LsfxC . /dest",
			mustContain: "--log-file=/data/var/log/x",
			mustNotHave: "--log-file=../../var/log/x",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := rewriteRsyncCommand(tt.cmd, "/data")
			joined := strings.Join(got, " ")
			if tt.mustContain != "" && !contains(got, tt.mustContain) {
				t.Errorf("expected confined path %q in %v", tt.mustContain, got)
			}
			if tt.mustNotHave != "" && contains(got, tt.mustNotHave) {
				t.Errorf("raw unconfined path %q leaked through: %v", tt.mustNotHave, got)
			}
			// flags must be left intact (bundled "." inside flags is not a separator)
			if !strings.Contains(joined, "--server") {
				t.Errorf("rsync flags were corrupted: %v", got)
			}
		})
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// TestRewriteRsyncCommand_FlagAllowlist: the exec runs unchrooted as root, so a
// dangerous server-side flag must REFUSE the session (nil), not run confined.
func TestRewriteRsyncCommand_FlagAllowlist(t *testing.T) {
	refused := []struct {
		name string
		cmd  string
	}{
		{"rogue daemon", "rsync --server --daemon --config=/dev/null ."},
		{"config file", "rsync --server --config=/data/x . /dest"},
		{"remote shell -e token", "rsync --server -e sh . /dest"},
		{"remote shell --rsh", "rsync --server --rsh=/bin/sh . /dest"},
		{"read device nodes", "rsync --server --copy-devices . /dest"},
		{"write device nodes", "rsync --server --write-devices . /dev/sda"},
		{"munge links off", "rsync --server --munge-links . /dest"},
		{"delete after send", "rsync --server --sender --remove-source-files . /data/x"},
		{"unexpected long flag", "rsync --server --made-up-flag . /dest"},
	}
	for _, tt := range refused {
		t.Run("refuse/"+tt.name, func(t *testing.T) {
			if got := rewriteRsyncCommand(tt.cmd, "/data"); got != nil {
				t.Errorf("expected REFUSAL (nil) for %q, got %v", tt.cmd, got)
			}
		})
	}

	allowed := []string{
		"rsync --server -logDtpre.iLsfxCIvu . /some/path",      // normal receive
		"rsync --server --sender -logDtpre.iLsfxC . /some/dir", // normal send
		"rsync --server -e.LsfxCIvu . /dest",                   // bundled caps marker, NOT -e/--rsh
		"rsync --server --files-from=/x . /dest",               // path-bearing, confined not refused
	}
	for _, cmd := range allowed {
		t.Run("allow/"+cmd, func(t *testing.T) {
			if got := rewriteRsyncCommand(cmd, "/data"); got == nil {
				t.Errorf("expected a rewritten command for a legitimate call %q, got refusal", cmd)
			}
		})
	}
}

// TestRewriteSCPCommand_FlagAllowlist: legacy scp exec runs unchrooted as root
// too — only the direction/recursion/verbosity flags are permitted.
func TestRewriteSCPCommand_FlagAllowlist(t *testing.T) {
	if got := rewriteSCPCommand("scp -t /dest", "/data"); got == nil {
		t.Error("scp -t (to) must be allowed")
	}
	if got := rewriteSCPCommand("scp -f /src", "/data"); got == nil {
		t.Error("scp -f (from) must be allowed")
	}
	if got := rewriteSCPCommand("scp -rp -t /dest", "/data"); got == nil {
		t.Error("scp -rp -t (bundled recursion+preserve) must be allowed")
	}
	// A path must still be confined.
	got := rewriteSCPCommand("scp -t /etc/shadow", "/data")
	if !contains(got, "/data/etc/shadow") {
		t.Errorf("scp path not confined: %v", got)
	}
	// An unknown/dangerous flag letter must refuse the whole session.
	for _, cmd := range []string{"scp -S /bin/sh -t /dest", "scp -o ProxyCommand=x -t /d", "scp -X -t /d"} {
		if got := rewriteSCPCommand(cmd, "/data"); got != nil {
			t.Errorf("expected REFUSAL for %q, got %v", cmd, got)
		}
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
