// Task target modal registry.
//
// `TaskTarget.modal` is a string key into this registry. Adding a new
// task kind that opens a modal requires touching this file (intended
// friction — the chip stays free of per-kind switch statements).

import { lazy, Suspense, type ComponentType } from 'react';

interface ModalCloseProps {
  readonly onClose: () => void;
}

interface RegistryEntry {
  readonly Component: ComponentType<Record<string, unknown> & ModalCloseProps>;
}

const TransitionProgressModal = lazy(() => import('@/components/TransitionProgressModal'));
const BulkProgressModal = lazy(() => import('@/components/BulkProgressModal'));
const OperationProgressModal = lazy(() => import('@/components/OperationProgressModal'));
const ProvisioningProgressModal = lazy(() => import('@/components/ProvisioningProgressModal'));
const ApplyHaProgressModal = lazy(() => import('@/components/ApplyHaProgressModal'));
// 2026-05-16: long-running mail ops registered with the task center.
// `mail-operation` is the generic kind for port-exposure flips +
// snapshot triggers (one-page lifecycle visible via task chip).
// `mail-migration` reuses the dedicated migration modal that already
// polls /admin/mail/migrate/:runId (per-step state machine UI).
const MailTaskProgressModal = lazy(() => import('@/components/MailTaskProgressModal'));
const MailMigrationProgressModal = lazy(() => import('@/components/MailMigrationProgressModal'));
// 2026-05-17: Phase 10 of snapshot-storage overhaul. Speedtest is a
// platform-scoped op (NOT tenant-scoped) — modal polls /me/tasks +
// /admin/backup-configs for the latest result.
const SpeedtestProgressModal = lazy(() => import('@/components/SpeedtestProgressModal'));
// 2026-05-22: Phase 4b PITR progress modal — chip click re-opens the
// step-stream timeline pointed at the in-flight Job. Without this
// the task's target was `type: 'route'` to the API path which 404'd.
const PitrProgressModal = lazy(() => import('@/components/backups/PitrProgressModal'));
// 2026-06-16: snapshot create enrolls a `storage.snapshot` task with a
// `snapshot-create` modal target so the chip re-opens this progress modal.
const SnapshotCreateProgressModal = lazy(() => import('@/components/SnapshotCreateProgressModal'));
// 2026-07-28: platform upgrade (ADR-045 re-pin). The apply enrolls a
// `platform.upgrade` task with `target.modal = 'platform-upgrade'` so the chip
// re-opens live roll progress + post-flight convergence.
const PlatformUpgradeProgressModal = lazy(() => import('@/components/PlatformUpgradeProgressModal'));
// 2026-08-11: additive apex-DNS repair. Detection is passive; this modal only
// appears for the operator-invoked fix, and the chip re-opens it so closing the
// modal never abandons an in-flight repair.
const DnsApexDriftTaskModal = lazy(() => import('@/components/DnsApexDriftTaskModal'));
// 2026-08-17: on-demand TLS certificate reissue (ADR-058 follow-up). The
// chip re-opens the step checklist, which carries cert-manager's own
// message for a stuck order.
const TlsReissueTaskModal = lazy(() => import('@/components/TlsReissueTaskModal'));

// Registry: modal key (matches `TaskTarget.modal`) → component. The
// chip wraps the rendered component in <Suspense> so the lazy import
// doesn't block the chip click handler.
//
// Each entry below corresponds to one or more `kind` values on the
// task row. The backend chooses `target.modal = 'foo'` and supplies
// the matching `target.modalProps` shape:
//
//   transition            → TransitionProgressModal     (tenant.transition)
//   bulk                  → BulkProgressModal           (tenant.*.bulk)
//   operation             → OperationProgressModal      (storage.*)
//   provisioning          → ProvisioningProgressModal   (tenant.provision)
//   platform-storage-apply→ ApplyHaProgressModal        (storage.tier-flip)
//   mail-operation        → MailTaskProgressModal       (mail.port-exposure, mail.snapshot.trigger, webmail.engine-flip)
//   mail-migration        → MailMigrationProgressModal  (mail.migration)
//
// Surfaces without a dedicated modal use `target.type = 'route'`
// instead.
const REGISTRY: Record<string, RegistryEntry> = {
  transition: {
    Component: TransitionProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  bulk: {
    Component: BulkProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  operation: {
    Component: OperationProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  provisioning: {
    Component: ProvisioningProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'platform-storage-apply': {
    Component: ApplyHaProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'dns-apex-drift-fix': {
    Component: DnsApexDriftTaskModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'tls-cert-reissue': {
    Component: TlsReissueTaskModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'mail-operation': {
    Component: MailTaskProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'mail-migration': {
    Component: MailMigrationProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'backup-speedtest': {
    Component: SpeedtestProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'pitr-progress': {
    Component: PitrProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'snapshot-create': {
    Component: SnapshotCreateProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'platform-upgrade': {
    Component: PlatformUpgradeProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
};

interface TaskModalHostProps {
  readonly modal: string;
  readonly props: Record<string, unknown>;
  readonly onClose: () => void;
}

/**
 * Lookup + render the modal that matches `target.modal`. Unknown keys
 * render nothing (and log a console warning) so a missing registry
 * entry doesn't crash the chip.
 */
export function TaskModalHost({ modal, props, onClose }: TaskModalHostProps) {
  const entry = REGISTRY[modal];
  if (!entry) {
    if (typeof console !== 'undefined') {
      console.warn(`[task-center] no modal registered for key "${modal}"`);
    }
    return null;
  }
  const { Component } = entry;
  return (
    <Suspense fallback={null}>
      <Component {...props} onClose={onClose} />
    </Suspense>
  );
}
