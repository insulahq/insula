// sftp-chroot — chroot + drop privileges (keeping DAC_OVERRIDE ambient) + exec.
// Compiled as a static binary. The SFTP gateway calls this with safe argument
// arrays (no shell interpolation) to eliminate injection vectors.
//
// The tenant PVC is mounted into the jail at <root>/home by the POD SPEC (the
// kubelet), so this binary performs NO mount itself — it only chroots and drops
// to nobody. That keeps the file-manager pod free of CAP_SYS_ADMIN (which is not
// permitted by the Pod Security "baseline" enforced on tenant namespaces); the
// only capabilities needed are SYS_CHROOT (chroot), SETUID/SETGID (drop to
// nobody) and DAC_OVERRIDE (read/write the tenant's files regardless of which
// UID owns them — website files are owned by the runtime's user, e.g. webuser).
// DAC_OVERRIDE is preserved across the UID drop as an AMBIENT capability so the
// unprivileged sftp-server keeps it. Trade-off: DAC_OVERRIDE also lets the user
// read/write the minimal jail scaffolding (a 2-line stub /etc/passwd, /dev/null,
// and the public sftp-server binary in /.platform) — it bypasses the mode-711
// "hidden" trick. That is acceptable: the chroot is the real boundary (it is NOT
// bypassed by DAC_OVERRIDE), nothing in the jail is secret, and the jail is
// per-tenant (an emptyDir in this tenant's own file-manager pod, over this
// tenant's own PVC). The only ambient cap is DAC_OVERRIDE — not FOWNER/CHOWN —
// so the user cannot change ownership or modes, only read/write within the jail.
//
// Usage: sftp-chroot --root <jail> <cmd> [args...]
//
// Example:
//
//	sftp-chroot --root /jail /.platform/sftp-server -e -d /home/public_html
package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"syscall"
)

// capDACOverride bypasses file read/write/execute permission checks. Kept as an
// ambient capability so the post-setuid sftp-server can access the tenant's
// files whatever UID owns them. Value from <linux/capability.h>.
const capDACOverride = 1

func main() {
	var root string
	var cmdIdx int

	// Parse flags (before the command).
	for i := 1; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--root":
			if i+1 >= len(os.Args) {
				fatal("--root requires an argument")
			}
			i++
			root = os.Args[i]
		default:
			cmdIdx = i
			goto done
		}
	}
done:
	if root == "" || cmdIdx == 0 || cmdIdx >= len(os.Args) {
		fmt.Fprintf(os.Stderr, "usage: sftp-chroot --root <jail> <cmd> [args...]\n")
		os.Exit(1)
	}

	// Validate root path — only safe characters allowed (defense-in-depth
	// against any upstream injection).
	if !isSafePath(root) {
		fatal("root path contains unsafe characters: " + root)
	}

	// Chroot into the jail. The tenant PVC is already mounted at <root>/home by
	// the pod spec, so no mount is performed here.
	if err := syscall.Chroot(root); err != nil {
		fatal(fmt.Sprintf("chroot %s: %v", root, err))
	}
	if err := syscall.Chdir("/"); err != nil {
		fatal(fmt.Sprintf("chdir /: %v", err))
	}

	// Run the command as nobody:nobody (65534), keeping DAC_OVERRIDE ambient so
	// the unprivileged process can still read/write the tenant's files. A child
	// process (not exec) keeps a clean parent for exit-code propagation.
	cmd := os.Args[cmdIdx]
	child := osexec.Command(cmd, os.Args[cmdIdx+1:]...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.Env = []string{"HOME=/", "PATH=/.platform"}
	child.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid:    65534,
			Gid:    65534,
			Groups: []uint32{65534},
		},
		// Preserve DAC_OVERRIDE across the UID transition. The Go runtime puts
		// it into the inheritable set and raises it in the ambient set after
		// setuid — permitted under no_new_privs because it grants no capability
		// the process did not already hold in its permitted set.
		AmbientCaps: []uintptr{capDACOverride},
	}

	exitCode := 0
	if err := child.Run(); err != nil {
		if exitErr, ok := err.(*osexec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			fmt.Fprintf(os.Stderr, "sftp-chroot: run %s: %v\n", cmd, err)
			exitCode = 1
		}
	}
	os.Exit(exitCode)
}

// isSafePath allows only ASCII alphanumeric chars, /, _, -, . in paths.
// Blocks shell metacharacters, spaces, control characters, and non-ASCII.
func isSafePath(p string) bool {
	for _, r := range p {
		isAlpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := r >= '0' && r <= '9'
		isAllowed := r == '/' || r == '_' || r == '-' || r == '.'
		if !isAlpha && !isDigit && !isAllowed {
			return false
		}
	}
	return true
}

func fatal(msg string) {
	fmt.Fprintf(os.Stderr, "sftp-chroot: %s\n", msg)
	os.Exit(1)
}
