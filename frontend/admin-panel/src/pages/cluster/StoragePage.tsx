import StorageSettings from '@/pages/StorageSettings';

/**
 * Cluster → Storage — Longhorn dashboard + active backup target.
 * Thin route-wrapper around the existing StorageSettings panel.
 */
export default function StoragePage() {
  return <StorageSettings />;
}
