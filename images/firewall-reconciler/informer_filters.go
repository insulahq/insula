// Informer UpdateFunc predicates — which Updates are worth a reconcile.
//
// The peer loop used to kick on EVERY Update, including the status writes
// it makes itself (and that its siblings on the other nodes make), and the
// periodic informer resync. Combined with an always-changing status patch
// that was a self-sustaining loop. A status-only change carries nothing
// the peer loop reads (it reads spec + metadata), so it no longer kicks;
// the floorReconcile ticker still guarantees a pass every 30 s.

package main

import (
	"maps"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"
)

// crdUpdateNeedsReconcile reports whether an Update of a ClusterTrustedRange
// / ClusterPendingPeer / ClusterFirewallBlacklist changed anything the peer
// loop acts on: the spec (metadata.generation — the CRDs have a status
// subresource, so status writes do not bump it), labels, annotations, or
// deletionTimestamp. Objects it cannot read fail open (kick).
func crdUpdateNeedsReconcile(oldObj, newObj any) bool {
	o, err := meta.Accessor(oldObj)
	if err != nil {
		return true
	}
	n, err := meta.Accessor(newObj)
	if err != nil {
		return true
	}
	return o.GetGeneration() != n.GetGeneration() ||
		metadataChanged(o, n)
}

// nodeUpdateNeedsReconcile reports whether a Node Update changed anything
// the peer / traffic loops read: addresses, labels, annotations, spec
// (which holds the taints), or deletionTimestamp. A kubelet heartbeat only
// moves status.conditions / status.images and must not kick. Objects that
// are not Nodes fail open (kick).
func nodeUpdateNeedsReconcile(oldObj, newObj any) bool {
	o, ok := oldObj.(*corev1.Node)
	if !ok {
		return true
	}
	n, ok := newObj.(*corev1.Node)
	if !ok {
		return true
	}
	return !equality.Semantic.DeepEqual(o.Status.Addresses, n.Status.Addresses) ||
		!equality.Semantic.DeepEqual(o.Spec, n.Spec) || // includes spec.taints
		metadataChanged(o, n)
}

// metadataChanged compares the metadata the predicates share: labels,
// annotations and deletionTimestamp.
func metadataChanged(o, n metav1.Object) bool {
	return !maps.Equal(o.GetLabels(), n.GetLabels()) ||
		!maps.Equal(o.GetAnnotations(), n.GetAnnotations()) ||
		!deletionTimestampEqual(o.GetDeletionTimestamp(), n.GetDeletionTimestamp())
}

func deletionTimestampEqual(a, b *metav1.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(b)
}

// isBackupShimPod reports whether an informer object (or a delete
// tombstone wrapping one) is a backup-rclone-shim Pod — the only Pods the
// traffic loop cares about.
func isBackupShimPod(obj any) bool {
	if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = tomb.Obj
	}
	p, ok := obj.(*corev1.Pod)
	if !ok {
		return false
	}
	return p.Namespace == backupShimNamespace && p.Labels[backupShimLabelKey] == backupShimLabelValue
}
