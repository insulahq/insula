import type { MigrateToWorkerResult } from '@insula/api-contracts';
import NodeName from '@/components/nodes/NodeName';

/**
 * What a migrate-to-worker actually did. "Restarted 0 deployment(s)" read as
 * success for a stopped tenant whose data had not moved at all; this says
 * where the data is going, or why it is not.
 */
export default function MigrateResultNote({ result }: { readonly result: MigrateToWorkerResult }) {
  const { currentWorker, deploymentsRestarted, dataRelocation } = result;
  const moving = dataRelocation.started.length;
  return (
    <div className="mt-2 space-y-1 text-xs" data-testid="migrate-result">
      <p className="text-green-700 dark:text-green-400">
        Pinned to <NodeName name={currentWorker} />
        {deploymentsRestarted > 0 ? <> — restarted {deploymentsRestarted} deployment(s)</> : null}.
        {moving > 0 && (
          <>
            {' '}Moving the data there now ({moving} volume{moving === 1 ? '' : 's'}); the placement view
            turns green once the copy is done.
          </>
        )}
        {moving === 0 && !dataRelocation.error && deploymentsRestarted > 0 && (
          <> The restarted workloads take the data with them; the placement view updates within a few minutes.</>
        )}
      </p>
      {dataRelocation.error && (
        <p className="text-amber-700 dark:text-amber-400" data-testid="migrate-relocation-error">
          The data could not be moved: {dataRelocation.error}. The pin is changed; the data stays where it is
          until a workload starts on <NodeName name={currentWorker} />.
        </p>
      )}
    </div>
  );
}
