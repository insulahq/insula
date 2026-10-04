import { useState } from 'react';
import DnsApexDriftModal from '@/components/DnsApexDriftModal';
import DnsApexDriftTaskModal from '@/components/DnsApexDriftTaskModal';
import { useDnsApexDriftReport } from '@/hooks/use-dns-apex-drift';

/**
 * The drift report modal and, once a repair starts, its progress modal — one
 * flow shared by the DNS Providers page and the dashboard tile, so both open
 * exactly the same thing.
 */
export default function DnsDriftFlow({ onClose }: { readonly onClose: () => void }) {
  const { data } = useDnsApexDriftReport();
  const [taskId, setTaskId] = useState<string | null>(null);
  if (taskId) return <DnsApexDriftTaskModal taskId={taskId} onClose={onClose} />;
  return (
    <DnsApexDriftModal
      report={data?.data ?? null}
      onClose={onClose}
      onFixStarted={setTaskId}
    />
  );
}
