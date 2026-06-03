package main

import (
	"bufio"
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// desiredConfigMapName is the operator-managed policy ConfigMap (seeded with
// defaults by platform-migration 0002, then operator-editable). Read once per
// loop so edits propagate without a pod restart.
const desiredConfigMapName = "host-config-desired"

// DesiredSysctl is one declared sysctl key/value.
type DesiredSysctl struct {
	Key   string
	Value string
}

// DesiredConfig is the parsed host-config-desired policy.
type DesiredConfig struct {
	Sysctls []DesiredSysctl
}

// loadDesired reads the host-config-desired ConfigMap. Returns (nil, nil) when
// ABSENT (no desired state ⇒ nothing to check — not an error), (cfg, nil) when
// present, (nil, err) only on a real API failure.
func loadDesired(ctx context.Context, client kubernetes.Interface, namespace string) (*DesiredConfig, error) {
	cm, err := client.CoreV1().ConfigMaps(namespace).Get(ctx, desiredConfigMapName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get %s: %w", desiredConfigMapName, err)
	}
	return parseDesired(cm.Data["sysctls"]), nil
}

// parseDesired parses sysctl.conf-style `key = value` lines: one per line,
// `#`/`;` comments + blank lines skipped, key + value trimmed. Tolerant of
// missing `=` (line skipped). Order is preserved.
func parseDesired(sysctls string) *DesiredConfig {
	cfg := &DesiredConfig{}
	sc := bufio.NewScanner(strings.NewReader(sysctls))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		if key == "" {
			continue
		}
		cfg.Sysctls = append(cfg.Sysctls, DesiredSysctl{Key: key, Value: val})
	}
	return cfg
}
