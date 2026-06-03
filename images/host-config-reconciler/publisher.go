package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// configMapPublisher writes ONE ConfigMap per node (host-config-drift-<node>)
// into platform-system with the JSON Snapshot at data.snapshot. This is the
// only mutation the reconciler performs — to its own ConfigMap, via the
// RBAC-scoped apiserver. An OwnerReference to the parent Node GCs the
// ConfigMap when the node is removed.
type configMapPublisher struct {
	client    kubernetes.Interface
	namespace string
	nodeName  string
}

func newConfigMapPublisher(c kubernetes.Interface, namespace, nodeName string) *configMapPublisher {
	return &configMapPublisher{client: c, namespace: namespace, nodeName: nodeName}
}

// publish writes the OBSERVE drift snapshot to host-config-drift-<node>.
func (p *configMapPublisher) publish(ctx context.Context, snap Snapshot) error {
	payload, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	return p.upsert(ctx, configMapName(p.nodeName), "snapshot", string(payload))
}

// publishApplied writes the CONVERGE applied snapshot to host-config-applied-<node>.
func (p *configMapPublisher) publishApplied(ctx context.Context, snap AppliedSnapshot) error {
	payload, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("marshal applied snapshot: %w", err)
	}
	return p.upsert(ctx, appliedConfigMapName(p.nodeName), "applied", string(payload))
}

// upsert create-or-updates a single-key ConfigMap owned by the parent Node (so
// it GCs with the node). Shared by the drift + applied publishers.
func (p *configMapPublisher) upsert(ctx context.Context, name, dataKey, payload string) error {
	node, err := p.client.CoreV1().Nodes().Get(ctx, p.nodeName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get parent node %q: %w", p.nodeName, err)
	}
	trueVal := true
	owner := metav1.OwnerReference{
		APIVersion:         "v1",
		Kind:               "Node",
		Name:               node.Name,
		UID:                node.UID,
		BlockOwnerDeletion: &trueVal,
		Controller:         &trueVal,
	}

	desired := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: p.namespace,
			Labels: map[string]string{
				"app":                                  "host-config-reconciler",
				"app.kubernetes.io/part-of":            "hosting-platform",
				"host-config-reconciler.platform/node": p.nodeName,
			},
			OwnerReferences: []metav1.OwnerReference{owner},
		},
		Data: map[string]string{dataKey: payload},
	}

	existing, err := p.client.CoreV1().ConfigMaps(p.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("get configmap %q: %w", name, err)
		}
		_, cerr := p.client.CoreV1().ConfigMaps(p.namespace).Create(ctx, desired, metav1.CreateOptions{})
		if cerr != nil {
			if apierrors.IsAlreadyExists(cerr) {
				slog.Info("configmap create race — retrying as update", "name", name)
				return p.update(ctx, name, desired)
			}
			return fmt.Errorf("create configmap %q: %w", name, cerr)
		}
		return nil
	}
	desired.ResourceVersion = existing.ResourceVersion
	if _, uerr := p.client.CoreV1().ConfigMaps(p.namespace).Update(ctx, desired, metav1.UpdateOptions{}); uerr != nil {
		return fmt.Errorf("update configmap %q: %w", name, uerr)
	}
	return nil
}

func (p *configMapPublisher) update(ctx context.Context, name string, cm *corev1.ConfigMap) error {
	existing, err := p.client.CoreV1().ConfigMaps(p.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get-for-update %q: %w", name, err)
	}
	cm.ResourceVersion = existing.ResourceVersion
	if _, err := p.client.CoreV1().ConfigMaps(p.namespace).Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update-after-race %q: %w", name, err)
	}
	return nil
}

// boundedName composes `<prefix><node>` bounded to k8s's 253-char object-name
// limit (the node portion is truncated if a pathologically long node name would
// overflow; real k3s node names are DNS labels ≤63 so it never fires — it just
// guarantees a valid Create rather than a perpetual 422 on a degenerate name).
func boundedName(prefix, nodeName string) string {
	maxNode := 253 - len(prefix)
	if len(nodeName) > maxNode {
		nodeName = nodeName[:maxNode]
	}
	return prefix + nodeName
}

// configMapName is the per-node OBSERVE drift ConfigMap name.
func configMapName(nodeName string) string { return boundedName("host-config-drift-", nodeName) }

// appliedConfigMapName is the per-node CONVERGE applied ConfigMap name.
func appliedConfigMapName(nodeName string) string { return boundedName("host-config-applied-", nodeName) }
