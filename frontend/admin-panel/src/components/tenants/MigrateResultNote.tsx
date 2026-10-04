import { useState } from 'react';
import type { MigrateToWorkerResult } from '@insula/api-contracts';
import NodeName from '@/components/nodes/NodeName';
import OperationProgressModal from '@/components/OperationProgressModal';
import { useNodeLabel } from '@/hooks/use-node-labels';

/**
 * What a migrate-to-worker actually did. "Restarted 0 deployment(s)" read as
 * success for a stopped tenant whose data had not moved at all; this says
 * where the data is going, or why it is not.
 */
export default function MigrateResultNote({ result }: { readonly result: MigrateToWorkerResult }) {
  const { currentWorker, deploymentsRestarted, dataRelocation, moveOperationId } = result;
  if (moveOperationId) return <MoveInProgressNote operationId={moveOperationId} target={currentWorker} />;
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

/**
 * A tenant running on another node is moved by a background storage
 * operation: stopped, its volume released by the old node, started on the
 * target. Its progress opens right away and can be reopened from here or from
 * the Task Tracker chip.
 */
function MoveInProgressNote({ operationId, target }: { readonly operationId: string; readonly target: string }) {
  const [showProgress, setShowProgress] = useState(true);
  const nodeLabel = useNodeLabel();
  return (
    <div className="mt-2 space-y-1 text-xs" data-testid="migrate-result">
      <p className="text-blue-700 dark:text-blue-300">
        Moving to <NodeName name={target} />: the tenant stops, its volume is released by the node it ran on,
        and it starts again on <NodeName name={target} /> — usually about a minute of downtime. Longhorn then
        copies the data there in the background.{' '}
        <button
          type="button"
          onClick={() => setShowProgress(true)}
          className="font-medium underline hover:text-blue-900 dark:hover:text-blue-100"
          data-testid="migrate-show-progress"
        >
          Show progress
        </button>
      </p>
      {showProgress && (
        <OperationProgressModal
          operationId={operationId}
          title={`Moving to ${nodeLabel(target)}`}
          onClose={() => setShowProgress(false)}
        />
      )}
    </div>
  );
}
