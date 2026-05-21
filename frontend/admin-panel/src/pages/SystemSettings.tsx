import { SettingsIcon } from 'lucide-react';
import SystemSettingsForm from '@/components/SystemSettings';
import IntegrationsSettings from '@/components/IntegrationsSettings';
import PlatformStoragePolicyCard from '@/components/PlatformStoragePolicyCard';
import NodeDefaultsCard from '@/components/NodeDefaultsCard';

export default function SystemSettings() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700 dark:text-gray-300" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="system-settings-heading">
            System Settings
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Platform identity, networking, mail, rate limits, and cluster-wide policies.
          </p>
        </div>
      </div>
      <SystemSettingsForm />
      <IntegrationsSettings />

      {/* 2026-05-21 Wave 2: PlatformStoragePolicyCard + NodeDefaultsCard
          moved here from the "Cluster Settings" tab of Nodes & Storage.
          Both are operator-rare cluster-wide policy knobs — they
          belonged in Settings, not on the Day-1 operational page. */}
      <PlatformStoragePolicyCard />
      <NodeDefaultsCard />
    </div>
  );
}
