import { useState, type FormEvent } from 'react';
import { X, Loader2, Globe, Terminal } from 'lucide-react';
import clsx from 'clsx';
import { useCreateCronJob, useUpdateCronJob } from '@/hooks/use-cron-jobs';
import { useDeployments } from '@/hooks/use-deployments';
import type { CronJob } from '@/types/api';

interface CronJobModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Tenant a NEW job belongs to. In edit mode the job's own tenant wins. */
  readonly tenantId: string;
  /**
   * Job being edited, or null/undefined to create a new one.
   *
   * The caller must also key the modal on the job id so switching rows
   * remounts it — the fields below initialise from `job` once, and a stale
   * form showing another job's schedule is worse than no edit button at all.
   */
  readonly job?: CronJob | null;
}

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function CronJobModal({ open, onClose, tenantId, job }: CronJobModalProps) {
  const editing = Boolean(job);
  const [name, setName] = useState(job?.name ?? '');
  const [type, setType] = useState<'webcron' | 'deployment'>(job?.type ?? 'webcron');
  const [schedule, setSchedule] = useState(job?.schedule ?? '');
  const [url, setUrl] = useState(job?.url ?? '');
  const [httpMethod, setHttpMethod] = useState<'GET' | 'POST' | 'PUT'>(
    (job?.httpMethod as 'GET' | 'POST' | 'PUT' | null | undefined) ?? 'GET',
  );
  const [command, setCommand] = useState(job?.command ?? '');
  const [deploymentId, setDeploymentId] = useState(job?.deploymentId ?? '');
  const [enabled, setEnabled] = useState(job ? Boolean(job.enabled) : true);

  // Cross-tenant list: the row being edited owns the tenant, not the filter.
  const jobTenantId = job?.tenantId ?? tenantId;
  const createCronJob = useCreateCronJob(tenantId);
  const updateCronJob = useUpdateCronJob(jobTenantId);
  const mutation = editing ? updateCronJob : createCronJob;
  const { data: deploymentsResponse } = useDeployments(jobTenantId);
  const deployments = (deploymentsResponse?.data ?? []).filter((d) => d.status === 'running');

  const resetForm = () => {
    setName('');
    setType('webcron');
    setSchedule('');
    setUrl('');
    setHttpMethod('GET');
    setCommand('');
    setDeploymentId('');
    setEnabled(true);
    createCronJob.reset();
    updateCronJob.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (job) {
        // Only the fields this modal actually renders. It has no timeout or
        // timezone input, so those keys are omitted rather than sent as null —
        // omitted means "leave it", and clearing a pin the admin cannot see
        // would be a silent edit.
        await updateCronJob.mutateAsync({
          cronJobId: job.id,
          name,
          schedule,
          ...(type === 'webcron'
            ? { url, http_method: httpMethod }
            : { command, deployment_id: deploymentId }),
          enabled,
        });
      } else {
        await createCronJob.mutateAsync({
          name,
          type,
          schedule,
          ...(type === 'webcron'
            ? { url, http_method: httpMethod }
            : { command, deployment_id: deploymentId }),
          enabled,
        });
      }
      handleClose();
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-cron-job-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {editing ? 'Edit Cron Job' : 'Add Cron Job'}
          </h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {mutation.error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="create-cron-job-error">
            {mutation.error instanceof Error
              ? mutation.error.message
              : editing ? 'Failed to save changes' : 'Failed to create cron job'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-cron-job-form">
          {/* Type selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType('webcron')}
                // Fixed once saved: type selects which field set the scheduler
                // reads, so flipping it would leave the row holding both a url
                // and a command.
                disabled={editing}
                title={editing ? 'A task\u2019s type cannot be changed \u2014 delete it and create a new one' : undefined}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  editing && 'cursor-not-allowed opacity-60',
                  type === 'webcron'
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-500'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
                data-testid="cron-type-webcron"
              >
                <Globe size={16} />
                Webcron
              </button>
              <button
                type="button"
                onClick={() => setType('deployment')}
                // Fixed once saved: type selects which field set the scheduler
                // reads, so flipping it would leave the row holding both a url
                // and a command.
                disabled={editing}
                title={editing ? 'A task\u2019s type cannot be changed \u2014 delete it and create a new one' : undefined}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  editing && 'cursor-not-allowed opacity-60',
                  type === 'deployment'
                    ? 'border-purple-500 bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-500'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
                data-testid="cron-type-deployment"
              >
                <Terminal size={16} />
                Deployment
              </button>
            </div>
          </div>

          {/* Type-specific fields */}
          {type === 'webcron' ? (
            <>
              <div>
                <label htmlFor="cron-job-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  URL *
                </label>
                <input
                  id="cron-job-url"
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className={INPUT_CLASS}
                  placeholder="https://example.com/cron.php"
                  data-testid="cron-job-url-input"
                />
              </div>
              <div>
                <label htmlFor="cron-job-method" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  HTTP Method
                </label>
                <select
                  id="cron-job-method"
                  value={httpMethod}
                  onChange={(e) => setHttpMethod(e.target.value as 'GET' | 'POST' | 'PUT')}
                  className={INPUT_CLASS}
                  data-testid="cron-job-method-select"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="cron-job-deployment" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Deployment *
                </label>
                <select
                  id="cron-job-deployment"
                  required
                  value={deploymentId}
                  onChange={(e) => setDeploymentId(e.target.value)}
                  className={INPUT_CLASS}
                  data-testid="cron-job-deployment-select"
                >
                  <option value="">Select a deployment...</option>
                  {deployments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cron-job-command" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Command *
                </label>
                <input
                  id="cron-job-command"
                  type="text"
                  required
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className={INPUT_CLASS}
                  placeholder="php artisan schedule:run"
                  data-testid="cron-job-command-input"
                />
              </div>
            </>
          )}

          {/* Common fields */}
          <div>
            <label htmlFor="cron-job-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Name *
            </label>
            <input
              id="cron-job-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={INPUT_CLASS}
              placeholder="My cron job"
              data-testid="cron-job-name-input"
            />
          </div>

          <div>
            <label htmlFor="cron-job-schedule" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Schedule *
            </label>
            <input
              id="cron-job-schedule"
              type="text"
              required
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className={INPUT_CLASS}
              placeholder="*/5 * * * *"
              data-testid="cron-job-schedule-input"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="cron-job-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
              data-testid="cron-job-enabled-checkbox"
            />
            <label htmlFor="cron-job-enabled" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Enabled
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-cron-job-button"
            >
              {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {editing ? 'Save Changes' : 'Add Cron Job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
