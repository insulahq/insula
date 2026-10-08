package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// readFirewallConf reads the operator-declared public TCP/UDP ports and
// SSH posture that bootstrap.sh persists for this node. Returns the
// "SSH public, nothing loaded" default when no file holds a posture — the UI
// surfaces "unknown" rather than a false-empty list.
//
// File format (KEY=val newline-separated):
//
//	PUBLIC_TCP_PORTS=22 80 443 8443 6443
//	PUBLIC_UDP_PORTS=51820 51821
//	SSH_VIA_MESH=true
//	SSH_VIA_MESH_INTERFACE=wt0
//
// Where it lives: see firewallConfPaths.
type firewallConf struct {
	publicTCP           []int
	publicUDP           []int
	sshViaMesh          bool
	sshViaMeshInterface *string
	ssh22IsPublic       bool
	loaded              bool
}

// firewallConfPaths are tried in order, relative to the host root.
//
//  1. Its own directory (bootstrap.sh and host-migration
//     2026.10.7/0001-firewall-conf-own-directory). The DaemonSet mounts this
//     directory and nothing else of /etc/hosting-platform, which is
//     /etc/insula — the platform's credential files live there.
//  2. The pre-2026.10.7 location, mounted as a single file so a node that has
//     not run that host-migration yet still reports its real posture. After
//     the migration it is a relative symlink to (1).
var firewallConfPaths = []string{
	"etc/hosting-platform/firewall/firewall.conf",
	"etc/hosting-platform/firewall.conf",
}

func readFirewallConf(hostRoot string) firewallConf {
	for _, rel := range firewallConfPaths {
		if fw, ok := parseFirewallConfFile(filepath.Join(hostRoot, rel)); ok {
			return fw
		}
	}
	// Default safe assumption: SSH IS public — bootstrap.sh has not gated
	// it. This is the truthful answer for any cluster that hasn't opted in
	// to --ssh-via-mesh yet.
	return firewallConf{ssh22IsPublic: true}
}

// parseFirewallConfFile returns ok=false when the file is missing or holds no
// recognised key: the kubelet creates an EMPTY file for a FileOrCreate mount
// whose source is absent, and that is "no posture on record", not "no public
// ports".
func parseFirewallConfFile(p string) (firewallConf, bool) {
	f, err := os.Open(p)
	if err != nil {
		return firewallConf{}, false
	}
	defer f.Close()
	out := firewallConf{loaded: true, ssh22IsPublic: true}
	recognised := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.ToUpper(strings.TrimSpace(k))
		v = strings.TrimSpace(v)
		v = strings.Trim(v, "\"'")
		switch k {
		case "PUBLIC_TCP_PORTS", "PUBLIC_UDP_PORTS", "SSH_VIA_MESH", "SSH_VIA_MESH_INTERFACE":
			recognised = true
		}
		switch k {
		case "PUBLIC_TCP_PORTS":
			out.publicTCP = parsePortList(v)
		case "PUBLIC_UDP_PORTS":
			out.publicUDP = parsePortList(v)
		case "SSH_VIA_MESH":
			out.sshViaMesh = strings.EqualFold(v, "true") || v == "1"
		case "SSH_VIA_MESH_INTERFACE":
			if v != "" {
				vv := v
				out.sshViaMeshInterface = &vv
			}
		}
	}
	// If SSH_VIA_MESH is true AND 22 is NOT listed in PUBLIC_TCP_PORTS,
	// SSH is scoped — not public.
	if out.sshViaMesh && !containsInt(out.publicTCP, 22) {
		out.ssh22IsPublic = false
	}
	if !recognised {
		return firewallConf{}, false
	}
	return out, true
}

func parsePortList(s string) []int {
	out := []int{}
	for _, tok := range strings.Fields(s) {
		// Accept comma-separated as well as space-separated.
		for _, p := range strings.Split(tok, ",") {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			n, err := strconv.Atoi(p)
			if err != nil || n < 1 || n > 65535 {
				continue
			}
			out = append(out, n)
		}
	}
	return out
}

func containsInt(haystack []int, needle int) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

// classifySSHRestriction derives the public-API enum from the
// (firewallConf, mesh) pair.
//
//	public           — SSH allowed on 0.0.0.0/0 (no scoping).
//	mesh-only        — SSH allowed only via the mesh interface.
//	trusted-only     — SSH allowed only from trusted_ranges saddr.
//	mesh-and-trusted — both scoping rules apply (the
//	                   --ssh-via-mesh path renders both).
func classifySSHRestriction(fw firewallConf) string {
	if !fw.sshViaMesh {
		return "public"
	}
	// bootstrap.sh's --ssh-via-mesh path always emits BOTH:
	//   iif "<iface>" tcp dport 22 accept
	//   ip saddr @trusted_ranges_v4 tcp dport 22 accept
	// So an operator who set --ssh-via-mesh has both scoping rules
	// active. trusted-only and mesh-only as standalone modes are
	// reserved for future operator overrides.
	return "mesh-and-trusted"
}

// conntrackPath is the conntrack table the probe samples — in its OWN procfs.
// The pod runs with hostNetwork, so /proc/net here is the host's network
// namespace and no hostPath is needed. A hostPath could not even be mounted on a
// kernel built without CONFIG_NF_CONNTRACK_PROCFS (Ubuntu 22.04/24.04): kubelet's
// FileOrCreate tries to create the file in procfs and the pod never starts.
const conntrackPath = "/proc/net/nf_conntrack"

// collectConntrack samples the conntrack table at path for recently
// dropped/invalid flows. Cheap but not authoritative — Felix iptables
// drop logs are the gold standard, but we don't ship a Felix log
// scraper today. Counts INVALID-state entries only; absence of the
// file (a kernel without the procfs table) => available:false.
//
// Phase 2.3 will extend this to a rolling top-N source-IP report;
// for Phase 1 we return only the count + window.
func collectConntrack(path string) ConntrackSnapshot {
	f, err := os.Open(path)
	if err != nil {
		reason := err.Error()
		return ConntrackSnapshot{Available: false, WindowSeconds: 60, Reason: &reason}
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	denies := 0
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "INVALID") {
			denies++
		}
	}
	if err := scanner.Err(); err != nil {
		reason := err.Error()
		return ConntrackSnapshot{Available: false, WindowSeconds: 60, Reason: &reason}
	}
	return ConntrackSnapshot{Available: true, Denies: &denies, WindowSeconds: 60}
}
