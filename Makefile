# Operator-facing convenience targets. Real build/test still lives in
# package.json scripts under backend/, frontend/admin-panel/, etc.
#
# Cluster smoke + failover targets require KUBECONFIG to be set to a
# cluster admin context (e.g. /tmp/k8s-staging/kubeconfig from staging).

# Pipefail by default so failing pipe stages (e.g. `age -d` failing
# upstream of `tar -xf -`) propagate. Without this, secrets-restore
# would silently succeed if decryption failed.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

.PHONY: help smoke smoke-public failover verdict diagnose secrets-fetch secrets-restore backup-target-key-status backup-target-key-rotate new-host-migration

# Default — list targets with one-line descriptions.
help:
	@awk 'BEGIN {FS = ":.*##"; printf "make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

smoke:        ## Full cluster-network smoke suite (needs KUBECONFIG)
	@scripts/smoke-test-cluster-network.sh

smoke-public: ## Test 1 only (external-IP DNS probe — no kubeconfig)
	@scripts/smoke-test-cluster-network.sh --skip 2,3,4,5,6

failover:     ## Induced-failure drills (DESTRUCTIVE — drains nodes)
	@scripts/failover-test.sh

verdict:      ## Quick PASS/FAIL count summary (JSON-driven)
	@scripts/smoke-test-cluster-network.sh --json 2>/dev/null \
		| awk -F'"' '/"status":"PASS"/ {p++} /"status":"FAIL"/ {f++} END {printf "PASS=%d FAIL=%d\n", p+0, f+0}'

new-host-migration: ## Scaffold a W10c host-migration (NAME=kebab-name [VERSION=YYYY.M.P])
	@if [ -z "$(NAME)" ]; then echo "usage: make new-host-migration NAME=relabel-longhorn-mount [VERSION=2026.7.1]" >&2; exit 2; fi
	@scripts/new-host-migration.sh "$(NAME)" $(if $(VERSION),--version "$(VERSION)",)

secrets-fetch: ## Pull bootstrap secrets bundle + operator key off a server (HOST=root@<ip> required)
	@if [ -z "$(HOST)" ]; then echo "usage: make secrets-fetch HOST=root@<server> [SSH_KEY=~/hosting-platform.key]" >&2; exit 2; fi
	@SSH_KEY="$${SSH_KEY:-$$HOME/hosting-platform.key}"; \
	DST="$${DST:-$$HOME/k8s-staging}"; \
	mkdir -p "$$DST"; \
	echo "fetching secrets artifacts from $(HOST) → $$DST/"; \
	ssh -i "$$SSH_KEY" -o StrictHostKeyChecking=accept-new $(HOST) 'ls /var/lib/hosting-platform/bundles/*.tar.age 2>/dev/null; ls /var/lib/hosting-platform/operator-key/*.key /var/lib/hosting-platform/operator-key/*.pub 2>/dev/null' \
	| while read -r REMOTE; do \
		[ -z "$$REMOTE" ] && continue; \
		BASE=$$(basename "$$REMOTE"); \
		echo "  $$REMOTE → $$DST/$$BASE"; \
		scp -q -i "$$SSH_KEY" -o StrictHostKeyChecking=accept-new "$(HOST):$$REMOTE" "$$DST/$$BASE"; \
	  done; \
	echo "done. Verify each file, then DELETE from server: ssh $(HOST) 'shred -u <path>'"

secrets-restore: ## Restore Secrets from a v2 bundle (BUNDLE=path KEY=path PROFILE=conservative|full DRY_RUN=0|1 EXTRACT_TO=path)
	@if [ -z "$(BUNDLE)" ] || [ -z "$(KEY)" ]; then echo "usage: make secrets-restore BUNDLE=~/k8s-staging/bundle.tar.age KEY=~/k8s-staging/operator-private.key [PROFILE=conservative|full] [DRY_RUN=1] [EXTRACT_TO=/tmp/restore]" >&2; exit 2; fi
	@if ! command -v age >/dev/null 2>&1; then echo "age not installed (apt-get install -y age)" >&2; exit 2; fi
	@if [ -z "$$KUBECONFIG" ]; then echo "KUBECONFIG must be set" >&2; exit 2; fi
	@PROFILE=$${PROFILE:-conservative}; \
	DRY_RUN=$${DRY_RUN:-0}; \
	EXTRACT_TO=$${EXTRACT_TO:-}; \
	OVERRIDE=$${OVERRIDE_SKIP_AT_RESTORE:-0}; \
	bash -c "RESTORE_PROFILE=$$PROFILE RESTORE_DRY_RUN=$$DRY_RUN RESTORE_EXTRACT_TO=\"$$EXTRACT_TO\" RESTORE_OVERRIDE_SKIP_AT_RESTORE=$$OVERRIDE source $(CURDIR)/scripts/lib/apply-secrets-bundle.sh && apply_secrets_bundle \"$(BUNDLE)\" \"$(KEY)\""
	@echo "done. Pods may need restart to pick up new Secret values: kubectl rollout restart -n <ns> deploy/<name>"

backup-target-key-status: ## Show BACKUP_TARGET_KEY fingerprint + last rotation (needs KUBECONFIG)
	@if [ -z "$$KUBECONFIG" ]; then echo "KUBECONFIG must be set" >&2; exit 2; fi
	@FP=$$(kubectl get secret -n platform backup-target-key -o jsonpath='{.data.fingerprint}' 2>/dev/null | base64 -d 2>/dev/null); \
	if [ -z "$$FP" ]; then echo "backup-target-key not found in platform/ (cluster bootstrapped?)" >&2; exit 1; fi; \
	GEN=$$(kubectl get secret -n platform backup-target-key -o jsonpath='{.data.generated_at}' 2>/dev/null | base64 -d 2>/dev/null); \
	ROT=$$(kubectl get secret -n platform backup-target-key -o jsonpath='{.data.rotated_at}' 2>/dev/null | base64 -d 2>/dev/null); \
	FROM=$$(kubectl get secret -n platform backup-target-key -o jsonpath='{.data.rotated_from}' 2>/dev/null | base64 -d 2>/dev/null); \
	echo "  fingerprint:   $$FP"; \
	echo "  generated:     $$GEN"; \
	if [ -n "$$ROT" ]; then echo "  last rotation: $$ROT"; fi; \
	if [ -n "$$FROM" ]; then echo "  rotated from:  $$FROM"; fi

backup-target-key-rotate: ## DESTRUCTIVE — rotate BACKUP_TARGET_KEY (invalidates all remote backups; see RFC §13b)
	@if [ -z "$$KUBECONFIG" ]; then echo "KUBECONFIG must be set" >&2; exit 2; fi
	@bash $(CURDIR)/scripts/backup-target-key-rotate.sh

diagnose:     ## Capture forensic snapshot (nodes/pods/Felix logs) under docs/diagnostics/<utc-stamp>/
	@DST=docs/diagnostics/$$(date -u '+%Y%m%dT%H%M%SZ'); mkdir -p "$$DST"; \
	echo "diagnostics → $$DST"; \
	kubectl get nodes -o wide > $$DST/nodes.txt 2>&1; \
	kubectl get pods -A -o wide > $$DST/pods.txt 2>&1; \
	kubectl get installation default -o yaml > $$DST/installation.yaml 2>&1 || true; \
	kubectl get felixconfigurations.crd.projectcalico.org default -o yaml > $$DST/felix.yaml 2>&1 || true; \
	kubectl logs -n calico-system -l k8s-app=calico-node --tail=200 --max-log-requests=10 > $$DST/calico-node-logs.txt 2>&1 || true; \
	scripts/smoke-test-cluster-network.sh > $$DST/smoke.log 2>&1 || true; \
	echo "done. Files: $$(ls $$DST | tr '\n' ' ')"
