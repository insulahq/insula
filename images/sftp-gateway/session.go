package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gliderlabs/ssh"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Session represents an active SSH/SFTP/SCP/rsync session.
type Session struct {
	ID                    string
	Username              string
	SftpUserID            string
	TenantID              string
	Namespace             string
	Protocol              string // "sftp", "scp", "rsync", "exec"
	SourceIP              string
	StartTime             time.Time
	HomePath              string
	AllowWrite            bool
	MaxConcurrentSessions int
}

// SessionManager tracks active sessions and enforces concurrency limits.
type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	byUser   map[string]int
	total    int
	maxTotal int
}

// NewSessionManager creates a SessionManager with the given total connection cap.
func NewSessionManager(maxTotal int) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		byUser:   make(map[string]int),
		maxTotal: maxTotal,
	}
}

// ---- session bookkeeping ---------------------------------------------------

func (m *SessionManager) register(sess *Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.total >= m.maxTotal {
		return fmt.Errorf("max total connections (%d) reached", m.maxTotal)
	}

	// Per-user cap: use the limit from the database (via auth response), default 3.
	perUserMax := sess.MaxConcurrentSessions
	if perUserMax <= 0 {
		perUserMax = 3
	}
	if m.byUser[sess.Username] >= perUserMax {
		return fmt.Errorf("max per-user connections (%d) reached for %s", perUserMax, sess.Username)
	}

	m.sessions[sess.ID] = sess
	m.byUser[sess.Username]++
	m.total++
	return nil
}

func (m *SessionManager) unregister(id, username string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.sessions[id]; ok {
		delete(m.sessions, id)
		m.byUser[username]--
		if m.byUser[username] <= 0 {
			delete(m.byUser, username)
		}
		m.total--
	}
}

// ---- main handler ----------------------------------------------------------

// HandleSession is the unified session handler for SFTP subsystem requests and
// exec requests (SCP / rsync / generic).
// If rawCmd is nil the request is an SFTP subsystem; otherwise it is an exec.
func (m *SessionManager) HandleSession(sshSess ssh.Session, protocol string, rawCmd *string) {
	authResult, ok := sshSess.Context().Value(authResultKey).(*AuthResult)
	if !ok || authResult == nil {
		log.Println("session: missing auth result")
		_ = sshSess.Exit(1)
		return
	}

	sourceIP := remoteIP(sshSess.RemoteAddr().String())

	// Determine protocol from raw command if this is an exec request.
	if rawCmd != nil {
		protocol = classifyCommand(*rawCmd)
	}

	// Generate a cryptographically random session ID.
	sessIDBytes := make([]byte, 16)
	rand.Read(sessIDBytes)

	sess := &Session{
		ID:                    fmt.Sprintf("%x", sessIDBytes),
		Username:              sshSess.User(),
		SftpUserID:            authResult.SftpUserID,
		TenantID:              authResult.TenantID,
		Namespace:             authResult.Namespace,
		Protocol:              protocol,
		SourceIP:              sourceIP,
		StartTime:             time.Now(),
		HomePath:              authResult.HomePath,
		AllowWrite:            authResult.AllowWrite,
		MaxConcurrentSessions: authResult.MaxConcurrentSessions,
	}

	if err := m.register(sess); err != nil {
		log.Printf("session: registration failed: %v", err)
		fmt.Fprintf(sshSess.Stderr(), "connection limit exceeded\n")
		_ = sshSess.Exit(1)
		return
	}
	defer m.unregister(sess.ID, sess.Username)

	log.Printf("session %s: %s %s@%s namespace=%s", sess.ID, sess.Protocol, sess.Username, sourceIP, sess.Namespace)

	// Report CONNECT audit event (best-effort).
	go func() {
		_ = ReportAuditEvent(AuditEvent{
			SftpUserID: sess.SftpUserID,
			TenantID:   sess.TenantID,
			Event:      "CONNECT",
			SourceIP:   sourceIP,
			Protocol:   sess.Protocol,
			SessionID:  sess.ID,
		})
	}()

	// Ensure file-manager pod is running.
	podName, err := resolveFileManagerPod(sess.Namespace)
	if err != nil {
		log.Printf("session %s: pod resolution failed: %v", sess.ID, err)
		fmt.Fprintf(sshSess.Stderr(), "failed to prepare file system: %v\n", err)
		_ = sshSess.Exit(1)
		return
	}

	// Build exec command. buildCommand returns nil for a command we refuse:
	// either an unrecognised protocol, or an scp/rsync invocation carrying a
	// disallowed flag (the rewriters allowlist flags — the exec runs unchrooted
	// as root, so a rogue --daemon / -e / --write-devices must never reach it).
	command := buildCommand(protocol, rawCmd, authResult.HomePath)
	if command == nil {
		log.Printf("session %s: rejected command (protocol=%s)", sess.ID, protocol)
		fmt.Fprintf(sshSess.Stderr(), "refused — only plain SFTP, SCP, and rsync file transfers are permitted\n")
		_ = sshSess.Exit(1)
		return
	}

	log.Printf("session %s: exec in pod %s/%s: %v", sess.ID, sess.Namespace, podName, command)

	// Execute bidirectional pipe into the pod.
	exitCode := execAndPipe(sshSess, sess.Namespace, podName, command)

	// Report audit event (best-effort).
	duration := time.Since(sess.StartTime)
	go func() {
		_ = ReportAuditEvent(AuditEvent{
			SftpUserID:      sess.SftpUserID,
			TenantID:        sess.TenantID,
			Event:           "DISCONNECT",
			SourceIP:        sourceIP,
			Protocol:        sess.Protocol,
			SessionID:       sess.ID,
			DurationSeconds: int(duration.Seconds()),
		})
	}()

	_ = sshSess.Exit(exitCode)
}

// ---- helpers ---------------------------------------------------------------

// classifyCommand determines the protocol from a raw exec command string.
func classifyCommand(cmd string) string {
	trimmed := strings.TrimSpace(cmd)
	switch {
	case strings.HasPrefix(trimmed, "scp "):
		return "scp"
	case strings.HasPrefix(trimmed, "rsync "):
		return "rsync"
	default:
		return "exec"
	}
}

// buildCommand returns the command slice to exec in the file-manager pod.
// SFTP uses chroot to /data so all file operations (including absolute paths)
// are confined to the PVC. SCP and rsync use path rewriting instead because
// their command arguments are fully controlled by the gateway.
func buildCommand(protocol string, rawCmd *string, homePath string) []string {
	dataRoot := filepath.Clean("/data/" + strings.TrimPrefix(homePath, "/"))

	switch protocol {
	case "sftp":
		// sftp-serve (static Go binary) chroots into the tenant PVC and serves
		// SFTP IN-PROCESS — no exec after the chroot, so the jail needs no
		// scaffolding at all: the tenant's "/" is exactly their own data. It
		// drops to nobody keeping only DAC_OVERRIDE (no ambient caps; ambient
		// only matters across execve, and there is no execve).
		//
		// --home is the sftp_user's home_path and is ENFORCED: sftp-serve
		// chroots into root+home, so a scoped account physically cannot name a
		// path outside its subdirectory. It used to be OpenSSH's -d, which only
		// sets a STARTING directory — a user scoped to /public_html could just
		// `cd /` and see the tenant's whole PVC. Pass it raw: sftp-serve
		// sanitises it and resolves it with openat2(RESOLVE_BENEATH), so a
		// tenant-planted symlink cannot redirect the chroot out of the PVC.
		return []string{
			"sftp-serve",
			"--root", "/data",
			"--home", confineHome(homePath),
		}
	case "scp":
		if rawCmd != nil {
			return rewriteSCPCommand(*rawCmd, dataRoot)
		}
		return []string{"/usr/lib/ssh/sftp-server", "-e", "-d", dataRoot}
	case "rsync":
		if rawCmd != nil {
			return rewriteRsyncCommand(*rawCmd, dataRoot)
		}
		return []string{"/usr/lib/ssh/sftp-server", "-e", "-d", dataRoot}
	default:
		// Reject unrecognised commands — only sftp/scp/rsync are allowed.
		return nil
	}
}

// confineHome sanitises the sftp_user's home_path into a PVC-relative scope.
//
// It returns a path relative to the PVC ROOT ("/" or "/public_html") — NOT the
// old "/home/..." form. That prefix existed because the old design chrooted to
// /jail with the PVC mounted at /jail/home; sftp-serve chroots into the PVC
// itself, so a "/home/" prefix would name a directory that does not exist.
//
// homePath comes from the trusted sftp-user record, but is sanitised anyway:
// any ".." component or null byte falls back to "/" (the PVC root). This is
// defence in depth — sftp-serve re-sanitises and, crucially, resolves the
// result with openat2(RESOLVE_BENEATH), which is what actually guarantees a
// tenant symlink cannot escape the PVC.
func confineHome(homePath string) string {
	if strings.ContainsRune(homePath, 0) {
		return "/"
	}
	sub := strings.Trim(homePath, "/")
	if sub == "" {
		return "/"
	}
	for _, part := range strings.Split(sub, "/") {
		if part == ".." {
			return "/"
		}
	}
	candidate := filepath.Clean("/" + sub)
	if candidate == "/" || strings.HasPrefix(candidate, "/") {
		return candidate
	}
	return "/"
}

// sanitizePath cleans a path argument and confines it under dataRoot.
// Returns dataRoot if the path would escape or contains null bytes.
func sanitizePath(arg, dataRoot string) string {
	if strings.ContainsRune(arg, 0) {
		return dataRoot
	}
	clean := filepath.Clean("/" + arg)
	joined := filepath.Clean(dataRoot + clean)
	if !strings.HasPrefix(joined, dataRoot+"/") && joined != dataRoot {
		return dataRoot
	}
	return joined
}

// scpAllowedFlags are the ONLY flags a legitimate legacy `scp` server call
// carries. Modern scp (OpenSSH 9+) uses the SFTP protocol and goes through the
// chrooted sftp-serve instead, so this exec path is legacy-only. A real server
// invocation is `scp [-v] [-r] [-p] [-d] {-t|-f} <path>`; -t (to) and -f (from)
// are mandatory-direction flags. Anything else is refused.
var scpAllowedFlags = map[string]bool{
	"-t": true, "-f": true, "-r": true, "-p": true, "-d": true, "-v": true, "-E": true,
}

// rewriteSCPCommand confines a legacy `scp` server invocation: it rewrites path
// arguments under dataRoot AND refuses any flag outside the allowlist (returns
// nil → caller rejects the session). scp over SSH runs unchrooted as root, so
// like rsync this rewrite is the only boundary. Previously all flags were
// skipped without inspection.
func rewriteSCPCommand(cmd, dataRoot string) []string {
	parts := strings.Fields(cmd)
	if len(parts) == 0 {
		return nil
	}
	rewritten := make([]string, len(parts))
	copy(rewritten, parts)

	for i := 1; i < len(rewritten); i++ {
		arg := rewritten[i]
		if strings.HasPrefix(arg, "-") {
			// scp flags are single-dash, may be bundled (e.g. "-rp"). Each
			// letter must be in the allowlist.
			for _, c := range arg[1:] {
				if !scpAllowedFlags["-"+string(c)] {
					log.Printf("scp: refusing unexpected flag %q in %q", string(c), arg)
					return nil
				}
			}
			continue
		}
		rewritten[i] = sanitizePath(arg, dataRoot)
	}
	return rewritten
}

// rsyncDeniedLongFlags are `--flag` forms that a legitimate SFTP-gateway rsync
// transfer NEVER needs and that are dangerous when the server runs unchrooted as
// root. Denied outright (the session is refused), not sanitised:
//
//	--daemon / --config       — turn the exec into a rogue rsync daemon
//	--rsh / -e (see below)     — spawn an arbitrary remote shell
//	--copy-devices / --write-devices — read/clobber /dev nodes on the host pod
//	--munge-links             — defeats symlink munging in a way that can aid escape
//	--remove-source-files     — lets a --sender delete after reading
//	--sockopts / --protect-args flips that change parsing semantics
//
// A real client never sends these on the SERVER side; only a hand-crafted
// command does. Path-bearing long flags (--files-from= &c) are still
// sanitised below, not denied.
var rsyncDeniedLongFlags = map[string]bool{
	"--daemon": true, "--config": true, "--rsh": true, "--server-alias": true,
	"--copy-devices": true, "--write-devices": true, "--munge-links": true,
	"--remove-source-files": true, "--remove-sent-files": true,
	"--sockopts": true, "--rsync-path": true, "--log-file-format": true,
}

// rsyncPathBearingLongFlags take a filesystem path after "=" that MUST be
// confined under dataRoot (the flag itself is legitimate).
var rsyncPathBearingLongFlags = map[string]bool{
	"--files-from": true, "--exclude-from": true, "--include-from": true,
	"--log-file": true, "--partial-dir": true, "--temp-dir": true,
	"--compare-dest": true, "--copy-dest": true, "--link-dest": true, "--backup-dir": true,
}

// rewriteRsyncCommand confines an `rsync --server` invocation. rsync over SSH
// runs UNCHROOTED in the file-manager pod (as root), so this is the ONLY
// boundary — unlike SFTP/SCP, which now go through the chrooted sftp-serve.
//
// It does TWO things, in order of importance:
//
//  1. FLAG ALLOWLIST. A legitimate server call is always
//     `rsync --server [--sender] -<bundled short opts> . <path>...`. Anything
//     with a denied flag (a rogue --daemon, an -e/--rsh remote shell, a device
//     read) is REFUSED — the function returns nil and the caller rejects the
//     session. Previously flags were not inspected at all, so a hand-crafted
//     `rsync --server --daemon ...` or `rsync --server -e"sh -c id" ...` reached
//     the exec (it failed only by luck — verified on staging 2026-07-15).
//  2. PATH CONFINEMENT. Every positional path, and the value of every
//     path-bearing long flag, is rewritten under dataRoot. A crafted command
//     that omits the "." placeholder does not escape, because every non-flag
//     token is confined regardless of position.
//
// Returns nil to signal "refuse this session".
func rewriteRsyncCommand(cmd, dataRoot string) []string {
	parts := strings.Fields(cmd)
	if len(parts) == 0 {
		return nil
	}
	rewritten := make([]string, len(parts))
	copy(rewritten, parts)

	for i := 1; i < len(rewritten); i++ {
		arg := rewritten[i]
		if !strings.HasPrefix(arg, "-") {
			// The lone "." source placeholder is the rsync reference dir, not a
			// filesystem target — leave it so the wire protocol still parses.
			if arg == "." {
				continue
			}
			rewritten[i] = sanitizePath(arg, dataRoot)
			continue
		}

		// Long flag: split off any "=value".
		if strings.HasPrefix(arg, "--") {
			name := arg
			if eq := strings.Index(arg, "="); eq != -1 {
				name = arg[:eq]
			}
			if rsyncDeniedLongFlags[name] {
				log.Printf("rsync: refusing dangerous flag %q", name)
				return nil
			}
			if rsyncPathBearingLongFlags[name] {
				if eq := strings.Index(arg, "="); eq != -1 {
					val := arg[eq+1:]
					if val != "" {
						rewritten[i] = arg[:eq+1] + sanitizePath(val, dataRoot)
					}
				}
				// The `--flag value` (space-separated) form is confined when the
				// value is reached as a positional token above.
				continue
			}
			// --server and --sender are the ONLY long flags a legitimate rsync
			// server invocation carries (--server is mandatory; --sender marks a
			// download). Everything else it needs is bundled into the short-flag
			// string. Allow exactly these two; refuse any other long flag rather
			// than pass an unknown to a root, unchrooted rsync.
			if name == "--server" || name == "--sender" {
				continue
			}
			log.Printf("rsync: refusing unexpected long flag %q", name)
			return nil
		}

		// Short-flag bundle, e.g. "-logDtpre.iLsfxCIvu". A bundled "e" here is
		// the rsync protocol's own remote-shell-capabilities marker (part of the
		// negotiated option string), NOT the -e/--rsh remote-shell flag, which
		// on the server side only ever appears as its own token. But a bundle
		// that IS exactly "-e" (its own token) is the remote-shell flag — deny.
		if arg == "-e" {
			log.Printf("rsync: refusing -e/--rsh remote-shell flag")
			return nil
		}
		// Otherwise it is a bundle of transfer options — safe, no path.
	}
	return rewritten
}

// resolveFileManagerPod ensures the file-manager is running and finds its pod.
func resolveFileManagerPod(namespace string) (string, error) {
	// First ask the backend to ensure the pod is ready.
	podName, err := EnsureFileManager(namespace)
	if err != nil {
		log.Printf("ensure-file-manager call failed: %v, falling back to direct pod lookup", err)
	}
	if podName != "" {
		return podName, nil
	}

	// Fallback: list pods with label selector.
	return findFileManagerPod(namespace)
}

// findFileManagerPod searches for a running file-manager pod in the namespace.
func findFileManagerPod(namespace string) (string, error) {
	pods, err := kubeClientset.CoreV1().Pods(namespace).List(context.Background(), metav1.ListOptions{
		LabelSelector: "app=file-manager",
		Limit:         1,
	})
	if err != nil {
		return "", fmt.Errorf("list file-manager pods: %w", err)
	}
	if len(pods.Items) == 0 {
		return "", fmt.Errorf("no file-manager pod found in namespace %s", namespace)
	}

	pod := pods.Items[0]
	if pod.Status.Phase != "Running" {
		return "", fmt.Errorf("file-manager pod %s is %s, not Running", pod.Name, pod.Status.Phase)
	}
	return pod.Name, nil
}

// execAndPipe runs a command in the file-manager pod and pipes stdin/stdout/stderr
// bidirectionally to/from the SSH session. Returns the exit code.
func execAndPipe(sshSess ssh.Session, namespace, podName string, command []string) int {
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()

	// ONLY the stdout copier is waited on. The stdin copier MUST NOT be, or
	// rsync deadlocks:
	//
	//   io.Copy(stdinWriter, sshSess) blocks READING from the SSH session until
	//   the CLIENT closes its stdin. rsync's client never does — it finishes
	//   sending, then waits for the server's exit-status. But we only send
	//   exit-status (sshSess.Exit, in the caller) AFTER this function returns.
	//   Waiting on the stdin copier therefore means: client waits for
	//   exit-status → we wait for client EOF → forever.
	//
	//   Closing stdinReader does not rescue it: the copier is parked in a READ
	//   on sshSess, and only notices the closed pipe on its next WRITE.
	//
	//   sftp and scp hid this bug because both close the channel when they are
	//   done, which unblocks the read. rsync transferred the file correctly and
	//   then hung forever — verified on staging 2026-07-15, payload on the PVC,
	//   client killed by timeout.
	//
	// The stdin copier is left running: it unblocks and exits on its own when
	// the caller sends exit-status and the SSH channel closes. It holds only the
	// two pipe ends, both of which are closed below.
	var outWg sync.WaitGroup

	// Goroutine: SSH session -> exec stdin. Deliberately NOT in outWg.
	go func() {
		defer stdinWriter.Close()
		_, _ = io.Copy(stdinWriter, sshSess)
	}()

	// Goroutine: exec stdout -> SSH session. This one IS waited on, so every
	// byte the server produced reaches the client before we report exit.
	outWg.Add(1)
	go func() {
		defer outWg.Done()
		defer stdoutReader.Close()
		_, _ = io.Copy(sshSess, stdoutReader)
	}()

	// Run exec (blocking).
	err := ExecInPod(namespace, podName, "file-manager", command, stdinReader, stdoutWriter, sshSess.Stderr())

	// Close the writer side so the stdout goroutine finishes, and the stdin read
	// side so the stdin copier errors out on its next write.
	stdoutWriter.Close()
	stdinReader.Close()

	outWg.Wait()

	if err != nil {
		log.Printf("exec error: %v", err)
		return 1
	}
	return 0
}
