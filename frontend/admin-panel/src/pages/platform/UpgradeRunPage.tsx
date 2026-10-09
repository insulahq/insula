import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import UpgradeProgressView from '@/components/platform/UpgradeProgressView';
import { useUpgradeRunById } from '@/hooks/use-platform-upgrade';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

/**
 * One upgrade run (ADR-064 §6): the live progress while it runs, and the record
 * of how it ended afterwards — reachable from the run history, the progress
 * dialog's "Open page", or a link someone shared.
 */
export default function UpgradeRunPage() {
  const { id } = useParams<{ id: string }>();
  const q = useUpgradeRunById(id);
  const error = q.error ? extractOperatorError(q.error) : null;
  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="upgrade-run-page">
      <Link
        to="/platform/updates"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
      >
        <ArrowLeft size={14} /> Platform updates
      </Link>
      {error && !q.data ? <ErrorPanel error={error} /> : <UpgradeProgressView runId={id} asPage />}
    </div>
  );
}
