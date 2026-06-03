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

func (p *configMapPublisher) publish(ctx context.Context, snap Snapshot) error {
	payload, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}

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

	name := configMapName(p.nodeName)
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
		Data: map[string]string{
			"snapshot": string(payload),
		},
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

// configMapName composes the deterministic per-node drift ConfigMap name.
// The `host-config-drift-` prefix is 18 chars; k8s object names cap at 253, so
// the node-name portion is truncated to 235 to keep the result valid even for
// a pathologically long node name (real k3s node names are DNS labels ≤63, so
// truncation never fires in practice — it just guarantees a valid Create
// rather than a perpetual 422 on a degenerate name).
func configMapName(nodeName string) string {
	const maxNode = 253 - len("host-config-drift-")
	if len(nodeName) > maxNode {
		nodeName = nodeName[:maxNode]
	}
	return "host-config-drift-" + nodeName
}
