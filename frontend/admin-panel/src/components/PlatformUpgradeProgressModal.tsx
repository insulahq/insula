import UpgradeProgressView from '@/components/platform/UpgradeProgressView';

/**
 * Re-openable Task Center progress modal for a platform upgrade
 * (`kind: platform.upgrade`, `target.modal: 'platform-upgrade'`). A view of the
 * same component the run's page renders (ADR-064 §6).
 */
interface Props {
  readonly version?: string;
  readonly onClose: () => void;
}

export default function PlatformUpgradeProgressModal({ version, onClose }: Props) {
  return <UpgradeProgressView version={version} onClose={onClose} />;
}
