// sftp-serve — chroot into the tenant PVC, drop privileges, and serve SFTP
// IN-PROCESS. Replaces the `sftp-chroot → /.platform/sftp-server` exec pair.
//
// WHY THIS EXISTS (the whole point):
//
// The old design chroot'ed and then EXEC'd OpenSSH's sftp-server. An exec after
// chroot forces the binary — and, because it is dynamically linked, its ELF
// interpreter and libraries — to exist INSIDE the jail. That is the sole reason
// the jail carried a `/.platform` tree (patchelf'd sftp-server + ld-musl +
// libs), plus a stub `/etc/passwd` (OpenSSH calls getpwuid() at startup and
// exits if it returns NULL) and a `/dev/null` (sanitise_stdfd() opens it
// unconditionally and exits on failure). All of it was READABLE and WRITABLE by
// the tenant, because the ambient DAC_OVERRIDE the design needs (to read files
// owned by the runtime user, e.g. webuser) also defeats the mode-711 "hidden"
// trick. A tenant could enumerate the scaffolding, and could brick their own
// SFTP by overwriting the jail's /etc/passwd (verified on staging 2026-07-15).
//
// Serving SFTP in-process removes the exec, and with it every reason for the
// jail to contain anything at all:
//
//   - no exec        ⇒ no binary, no ELF interpreter, no libs in the jail
//   - pure Go        ⇒ no libc NSS lookup, so no /etc/passwd
//   - no exec        ⇒ no ambient capabilities (ambient caps only survive
//                      execve; in-process we just keep DAC_OVERRIDE permitted
//                      across the setuid via PR_SET_KEEPCAPS)
//   - pkg/sftp       ⇒ never opens /dev/null
//
// So the chroot root IS the tenant's PVC: the tenant's "/" is exactly their own
// data, and there is nothing else in there to hide, read, or corrupt.
//
// ORDERING IS SECURITY-CRITICAL — do not reorder without reading this:
//
//	1. chroot(root) + chdir("/")  — while still root (needs CAP_SYS_CHROOT).
//	   chdir MUST follow chroot: a cwd left outside the new root is the classic
//	   chroot escape.
//	2. PR_SET_KEEPCAPS(1)         — otherwise setuid() clears the permitted set.
//	3. setgroups/setgid/setuid    — drop to nobody. GID BEFORE UID: once we are
//	   nobody we can no longer change groups.
//	4. capset(DAC_OVERRIDE)       — keep exactly one capability; drop the rest
//	   (notably SYS_CHROOT, so the dropped process cannot chroot again, and
//	   FOWNER/CHOWN, so it cannot change modes or ownership).
//	5. PR_SET_KEEPCAPS(0)         — restore the default for any later setuid.
//	6. serve                      — only now do we touch tenant-controlled bytes.
//
// Usage: sftp-serve --root <dir> [-d <start-subdir>]
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/pkg/sftp"
)

const (
	nobodyUID = 65534
	nobodyGID = 65534

	// From <linux/capability.h>. DAC_OVERRIDE bypasses file permission checks
	// so the unprivileged server can read/write tenant files whatever UID owns
	// them (website files belong to the runtime user, e.g. webuser). It does
	// NOT bypass the chroot — that is the real boundary — and it is the ONLY
	// capability we keep.
	capDACOverride = 1

	// prctl options, from <linux/prctl.h>.
	prSetKeepCaps = 8

	// Linux capability API version 3 (64-bit capabilities).
	linuxCapabilityVersion3 = 0x20080522
)

type capHeader struct {
	version uint32
	pid     int32
}

type capData struct {
	effective   uint32
	permitted   uint32
	inheritable uint32
}

// stdio adapts the SSH channel (stdin/stdout) to the io.ReadWriteCloser
// pkg/sftp serves over. Closing is a no-op: the gateway owns the channel
// lifetime, and closing our own stdio would race its teardown.
//
// TRADE-OFF: pkg/sftp's Serve() calls conn.Close() when a request worker errors,
// specifically to unblock its own blocking read so Serve() can return promptly.
// A no-op Close defeats that recovery path — a worker-level protocol error will
// not end the session early; we simply keep blocking on stdin until the gateway
// tears the channel down. That is acceptable because process lifetime IS session
// lifetime here (one exec per SSH session, gateway-owned teardown), but it does
// mean such errors are unobserved.
type stdio struct {
	io.Reader
	io.Writer
}

func (stdio) Close() error { return nil }

func fatalf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "sftp-serve: "+format+"\n", a...)
	os.Exit(1)
}

// confineStart resolves the configured start sub-directory INSIDE the new root.
// `sub` comes from the trusted sftp_users record, but it is sanitised anyway:
// any "..", null byte, or result escaping "/" collapses to "/". Defence in
// depth — the chroot already makes escape impossible; this only keeps the
// starting directory sane.
func confineStart(sub string) string {
	if strings.ContainsRune(sub, 0) {
		return "/"
	}
	clean := filepath.Clean("/" + strings.TrimPrefix(sub, "/"))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "/"
	}
	return clean
}

// dropPrivileges drops root → nobody while KEEPING exactly CAP_DAC_OVERRIDE.
// Must be called AFTER chroot (chroot needs CAP_SYS_CHROOT, which we drop here).
//
// BUILD CONSTRAINT — this binary MUST be built CGO_ENABLED=0. syscall.AllThreadsSyscall
// returns ENOTSUP in any binary linked with cgo (and the runtime panics outright),
// so enabling cgo makes this whole sequence fail at the first step. That is
// fail-closed (the process exits rather than serving as root), but it turns a
// dependency bump into a baffling "prctl(PR_SET_KEEPCAPS, 1): not supported"
// outage. The Dockerfile pins CGO_ENABLED=0; keep it that way.
func dropPrivileges() error {
	// Keep the permitted set across the UID transition; without this, setuid()
	// from root clears every capability and the server could not read tenant
	// files owned by other UIDs.
	// AllThreadsSyscall, NOT RawSyscall: Linux capabilities and KEEPCAPS are
	// PER-THREAD, and the Go runtime multiplexes goroutines across threads. A
	// per-thread drop leaves the goroutine that actually serves SFTP running on
	// some other thread WITHOUT DAC_OVERRIDE — reads of tenant files owned by
	// webuser then fail non-deterministically (observed: "permission denied" on
	// every read/write in the first prototype).
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prSetKeepCaps, 1, 0); errno != 0 {
		return fmt.Errorf("prctl(PR_SET_KEEPCAPS, 1): %w", errno)
	}

	// Groups first, then GID, then UID: after setuid(nobody) we would no longer
	// be privileged enough to change them.
	if err := syscall.Setgroups([]int{nobodyGID}); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	if err := syscall.Setgid(nobodyGID); err != nil {
		return fmt.Errorf("setgid: %w", err)
	}
	if err := syscall.Setuid(nobodyUID); err != nil {
		return fmt.Errorf("setuid: %w", err)
	}

	// Now pin the capability set to exactly DAC_OVERRIDE. Everything else the
	// container holds (SYS_CHROOT, FOWNER, CHOWN, SETUID, SETGID, MKNOD) is
	// dropped here — so the serving process cannot change ownership or modes,
	// and cannot regain privilege.
	//
	// The BOUNDING set is deliberately left alone (dropping it would need
	// CAP_SETPCAP, which the container does not hold). That is safe here: a
	// bounding-set capability can only re-enter `permitted` through an execve
	// of a file carrying file-capabilities, and this process never execs
	// anything — it serves SFTP in-process and exits. CAP_SETFCAP is also not
	// held, so no file could be given those capabilities in the first place.
	hdr := capHeader{version: linuxCapabilityVersion3, pid: 0}
	data := [2]capData{
		{effective: 1 << capDACOverride, permitted: 1 << capDACOverride, inheritable: 0},
		{}, // capabilities 32..63 — none
	}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data[0])), 0); errno != 0 {
		return fmt.Errorf("capset: %w", errno)
	}

	// Restore the default so a hypothetical later setuid behaves normally.
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prSetKeepCaps, 0, 0); errno != 0 {
		return fmt.Errorf("prctl(PR_SET_KEEPCAPS, 0): %w", errno)
	}
	return nil
}

// verifyDropped re-reads the live process state and refuses to serve unless the
// drop actually took effect. Fail-closed: a silent partial drop (e.g. a kernel
// that ignored KEEPCAPS, or a capset that no-op'd) would otherwise serve tenant
// traffic as root.
//
// It asserts the WHOLE capability words equal exactly DAC_OVERRIDE, not just
// that some specific bit is absent: a spot-check for one capability would miss
// a bug that left, say, CAP_SETUID behind.
//
// NOTE on the ambient set: capget(2) cannot report it — cap_user_data_t has
// only effective/permitted/inheritable. Ambient is readable only via
// /proc/self/status or PR_CAP_AMBIENT_IS_SET. We do not raise ambient caps
// anywhere (there is no execve to carry them across), and inheritable is
// asserted empty below, which is what makes an ambient bit unreachable: a
// capability can only enter the ambient set if it is in BOTH permitted and
// inheritable.
func verifyDropped() error {
	if uid, euid := os.Getuid(), os.Geteuid(); uid != nobodyUID || euid != nobodyUID {
		return fmt.Errorf("uid/euid are %d/%d, expected %d", uid, euid, nobodyUID)
	}
	if gid, egid := os.Getgid(), os.Getegid(); gid != nobodyGID || egid != nobodyGID {
		return fmt.Errorf("gid/egid are %d/%d, expected %d", gid, egid, nobodyGID)
	}

	eff, prm, inh, err := effectiveCaps()
	if err != nil {
		return err
	}
	const want = uint64(1) << capDACOverride
	if eff != want || prm != want {
		return fmt.Errorf("capabilities are effective=%#x permitted=%#x, expected exactly DAC_OVERRIDE (%#x)", eff, prm, want)
	}
	// Empty inheritable is what keeps the ambient set unreachable (a cap needs
	// permitted AND inheritable to be raised into ambient).
	if inh != 0 {
		return fmt.Errorf("inheritable capabilities are %#x, expected 0", inh)
	}
	return nil
}

// effectiveCaps returns the live effective/permitted/inheritable capability
// words for the calling thread, as 64-bit values.
func effectiveCaps() (effective, permitted, inheritable uint64, err error) {
	hdr := capHeader{version: linuxCapabilityVersion3, pid: 0}
	var data [2]capData
	if _, _, errno := syscall.RawSyscall(syscall.SYS_CAPGET,
		uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data[0])), 0); errno != 0 {
		return 0, 0, 0, fmt.Errorf("capget: %w", errno)
	}
	join := func(lo, hi uint32) uint64 { return uint64(lo) | uint64(hi)<<32 }
	return join(data[0].effective, data[1].effective),
		join(data[0].permitted, data[1].permitted),
		join(data[0].inheritable, data[1].inheritable), nil
}

func main() {
	var root, startSub string
	flag.StringVar(&root, "root", "", "directory to chroot into (the tenant PVC mount)")
	flag.StringVar(&startSub, "d", "/", "start directory INSIDE the chroot")
	flag.Parse()

	if root == "" {
		fatalf("--root is required")
	}
	// Purely lexical — no filesystem access — so this is equivalent before or
	// after the chroot. Done here to keep main()'s privileged section minimal.
	start := confineStart(startSub)

	// 1. chroot + chdir, while still privileged.
	if err := syscall.Chroot(root); err != nil {
		fatalf("chroot(%s): %v", root, err)
	}
	// chdir MUST come after chroot — a cwd outside the new root is an escape.
	if err := syscall.Chdir("/"); err != nil {
		fatalf("chdir(/): %v", err)
	}

	// 2-5. drop to nobody, keeping only DAC_OVERRIDE.
	if err := dropPrivileges(); err != nil {
		fatalf("dropping privileges: %v", err)
	}
	if err := verifyDropped(); err != nil {
		fatalf("privilege drop did not take effect: %v", err)
	}

	// The start dir may not exist (a tenant can delete their own public_html);
	// fall back to the PVC root rather than failing the session.
	if err := syscall.Chdir(start); err != nil {
		if err := syscall.Chdir("/"); err != nil {
			fatalf("chdir(/): %v", err)
		}
		start = "/"
	}

	// 6. serve. Everything past this point parses tenant-controlled bytes as an
	// unprivileged, chrooted process.
	srv, err := sftp.NewServer(stdio{os.Stdin, os.Stdout}, sftp.WithServerWorkingDirectory(start))
	if err != nil {
		fatalf("sftp server init: %v", err)
	}
	// errors.Is, not `!= io.EOF`: pkg/sftp currently normalises a clean
	// disconnect to nil internally, so this is inert today — but if a future
	// version wraps the sentinel (fmt.Errorf("...: %w", io.EOF)) a bare compare
	// would silently stop matching and turn a normal logout into a fatal error.
	if err := srv.Serve(); err != nil && !errors.Is(err, io.EOF) {
		fatalf("serve: %v", err)
	}
}
