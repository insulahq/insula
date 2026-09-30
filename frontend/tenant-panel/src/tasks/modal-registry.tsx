/**
 * Task-target modal registry — tenant panel.
 *
 * `TaskTarget.modal` is a string key into this registry. The chip renders
 * whatever it names, so adding a task kind that opens a modal means touching
 * this file (intended friction — the chip stays free of per-kind switches).
 *
 * WHY THIS FILE EXISTS. The tenant chip used to have no registry at all: its
 * header said every target arriving here "should be `type: 'route'`", and a
 * `modal` target was drawn as an inert info row. That assumption was already
 * false for the one task a tenant triggers most. A tenant's on-demand backup
 * enrolled a task whose target was the ADMIN route `/tenants/<id>?tab=backups`
 * — a path that does not exist in this panel — so the row went nowhere, and
 * closing the progress modal abandoned the run with no way back to it.
 *
 * Keys here must match what the backend emits;
 * `scripts/ci-task-modal-registry-check.sh` fails the build if one is missing.
 */

import { lazy, Suspense, type ComponentType } from 'react';

interface ModalCloseProps {
  readonly onClose: () => void;
}

interface RegistryEntry {
  readonly Component: ComponentType<Record<string, unknown> & ModalCloseProps>;
}

// A tenant's on-demand bundle. Polls per-component status (config, secrets,
// files, mailboxes) until the bundle reaches a terminal state.
const BundleProgressModal = lazy(async () => ({
  default: (await import('@/components/BundleProgressModal')).BundleProgressModal,
}));

export const TASK_MODALS: Record<string, RegistryEntry> = {
  'bundle-progress': {
    Component: BundleProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
};

export function TaskModalHost(
  { modal, props, onClose }: {
    readonly modal: string;
    readonly props: Record<string, unknown>;
    readonly onClose: () => void;
  },
): React.ReactElement | null {
  const entry = TASK_MODALS[modal];
  // An unknown key is a backend/frontend mismatch. Rendering nothing is the
  // right behaviour — the alternative is a blank modal the user cannot
  // interpret — and the CI guard is what stops it reaching anyone.
  if (!entry) return null;
  const { Component } = entry;
  return (
    <Suspense fallback={null}>
      <Component {...props} onClose={onClose} />
    </Suspense>
  );
}
