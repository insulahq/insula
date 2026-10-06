// Node traffic snapshot → ConfigMap `node-traffic-<NODE_NAME>` in
// platform-system (same one-ConfigMap-per-node contract as security-probe).
// platform-api reads data.snapshot:
//
//	{"version":1,"node":"<node>","sampledAt":"<RFC3339 UTC>","epoch":"<hex>",
//	 "counters":{"kubeapi":{"in":0,"out":0,"inPackets":0,"outPackets":0},
//	             "etcd":{…},"kubelet":{…},"tunnel":{…},"n2nother":{…},"backup":{…}}}
//
// in/out are cumulative IP bytes, inPackets/outPackets cumulative packets,
// since the table was (re)created; a new epoch means the counters restarted
// from zero. nft counts IP bytes — a consumer reconciling against NIC byte
// counts (which include the link-layer header) adds the per-frame header
// back using the packet counts.
//
// Write path: a JSON merge PATCH (no GET first); Create on NotFound. The
// Node is the ConfigMap's owner, so it is garbage-collected with the Node.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
)

const (
	trafficNamespace       = "platform-system"
	trafficCMPrefix        = "node-traffic-"
	trafficCMKey           = "snapshot"
	trafficSnapshotVersion = 1
)

var trafficCMLabels = map[string]string{
	"app.kubernetes.io/name":    "node-traffic",
	"app.kubernetes.io/part-of": "hosting-platform",
}

type trafficInOut struct {
	In         uint64 `json:"in"`
	Out        uint64 `json:"out"`
	InPackets  uint64 `json:"inPackets"`
	OutPackets uint64 `json:"outPackets"`
}

type trafficCounters struct {
	KubeAPI  trafficInOut `json:"kubeapi"`
	Etcd     trafficInOut `json:"etcd"`
	Kubelet  trafficInOut `json:"kubelet"`
	Tunnel   trafficInOut `json:"tunnel"`
	N2NOther trafficInOut `json:"n2nother"`
	Backup   trafficInOut `json:"backup"`
}

type trafficSnapshot struct {
	Version   int             `json:"version"`
	Node      string          `json:"node"`
	SampledAt string          `json:"sampledAt"`
	Epoch     string          `json:"epoch"`
	Counters  trafficCounters `json:"counters"`
}

func buildTrafficSnapshot(node string, sampledAt time.Time, r trafficReading) trafficSnapshot {
	pair := func(class string) trafficInOut {
		in := r.Counters[trafficCounterName(class, trafficDirIn)]
		out := r.Counters[trafficCounterName(class, trafficDirOut)]
		return trafficInOut{In: in.Bytes, Out: out.Bytes, InPackets: in.Packets, OutPackets: out.Packets}
	}
	return trafficSnapshot{
		Version:   trafficSnapshotVersion,
		Node:      node,
		SampledAt: sampledAt.UTC().Format(time.RFC3339),
		Epoch:     r.Epoch,
		Counters: trafficCounters{
			KubeAPI:  pair(classKubeAPI),
			Etcd:     pair(classEtcd),
			Kubelet:  pair(classKubelet),
			Tunnel:   pair(classTunnel),
			N2NOther: pair(classN2NOther),
			Backup:   pair(classBackup),
		},
	}
}

// trafficConfigMapName returns node-traffic-<node>, or an error when that is
// not a valid ConfigMap name (DNS-1123 subdomain, ≤253 chars).
func trafficConfigMapName(node string) (string, error) {
	name := trafficCMPrefix + node
	if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
		return "", fmt.Errorf("configmap name %q invalid: %s", name, strings.Join(errs, "; "))
	}
	return name, nil
}

// trafficCMPublisher writes the snapshot ConfigMap.
type trafficCMPublisher struct {
	client    kubernetes.Interface
	namespace string
	nodeName  string
	nodes     nodeLister // for the owner reference (informer cache, no GET)
}

func newTrafficPublisher(c kubernetes.Interface, nodeName string, nodes nodeLister) *trafficCMPublisher {
	return &trafficCMPublisher{client: c, namespace: trafficNamespace, nodeName: nodeName, nodes: nodes}
}

func (p *trafficCMPublisher) publish(ctx context.Context, snap trafficSnapshot) error {
	name, err := trafficConfigMapName(p.nodeName)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{"labels": trafficCMLabels},
		"data":     map[string]string{trafficCMKey: string(payload)},
	})
	if err != nil {
		return fmt.Errorf("marshal patch: %w", err)
	}
	cms := p.client.CoreV1().ConfigMaps(p.namespace)
	_, err = cms.Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err == nil || !apierrors.IsNotFound(err) {
		return p.wrapErr("patch", name, err)
	}

	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:            name,
			Namespace:       p.namespace,
			Labels:          trafficCMLabels,
			OwnerReferences: p.ownerRefs(),
		},
		Data: map[string]string{trafficCMKey: string(payload)},
	}
	_, err = cms.Create(ctx, cm, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		// Lost a create race (e.g. a pod restart overlapping) — patch it.
		_, err = cms.Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
		return p.wrapErr("patch after create race", name, err)
	}
	return p.wrapErr("create", name, err)
}

// ownerRefs points the ConfigMap at this node's Node object so the GC
// removes it when the node leaves the cluster. Best-effort: without the
// Node in the cache, the ConfigMap is created unowned.
func (p *trafficCMPublisher) ownerRefs() []metav1.OwnerReference {
	if p.nodes == nil {
		return nil
	}
	nodes, err := p.nodes.List(labels.Everything())
	if err != nil {
		return nil
	}
	for _, n := range nodes {
		if n.Name == p.nodeName && n.UID != "" {
			return []metav1.OwnerReference{{APIVersion: "v1", Kind: "Node", Name: n.Name, UID: n.UID}}
		}
	}
	return nil
}

func (p *trafficCMPublisher) wrapErr(op, name string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s configmap %s/%s: %w", op, p.namespace, name, err)
}
