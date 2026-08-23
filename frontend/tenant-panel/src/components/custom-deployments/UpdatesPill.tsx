// Compact "Updates available?" pill. Visual states:
//
//   no-update   → silent green checkmark
//   patch       → blue "patch available"       (semver → onUpgrade)
//   minor       → amber "minor available"       (semver → onUpgrade)
//   major       → red "major available"         (semver → onUpgrade)
//   digest      → amber "update available"      (moving tag republished → onRepull)
//   unknown     → muted "unknown" with the registry's reason on hover
//
// A semver bump opens the upgrade (change-tag) modal via onUpgrade. A `digest`
// update means the SAME tag was republished, so the fix is a re-pull — wired
// to onRepull instead.

import { ArrowUpCircle, Check, HelpCircle, Loader2, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import type { UpdateCheckResult } from '@insula/api-contracts';

interface UpdatesPillProps {
  readonly result: UpdateCheckResult | undefined;
  readonly loading: boolean;
  readonly canManage: boolean;
  readonly onUpgrade: () => void;
  /** Re-pull the current tag (for a `digest` update). */
  readonly onRepull: () => void;
}

export function UpdatesPill({ result, loading, canManage, onUpgrade, onRepull }: UpdatesPillProps) {
  if (loading && !result) {
    return <Loader2 size={14} className="animate-spin text-gray-400" />;
  }
  if (!result) {
    return <span className="text-xs text-gray-400">—</span>;
  }

  const baseCls = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium';

  if (result.status === 'no-update') {
    return (
      <span className={clsx(baseCls, 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300')}>
        <Check size={12} /> up to date
      </span>
    );
  }

  if (result.status === 'digest') {
    // Moving tag (`latest`, `1.27`) republished to a new image → re-pull.
    return (
      <button
        type="button"
        disabled={!canManage}
        onClick={onRepull}
        className={clsx(baseCls, 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300', canManage ? 'cursor-pointer hover:brightness-95' : 'cursor-default')}
        title={`The registry re-published ${result.current ?? 'this tag'}${result.latest ? ` (${result.latest})` : ''} — click to re-pull`}
      >
        <RefreshCw size={12} /> update available
      </button>
    );
  }

  if (result.status === 'unknown') {
    return (
      <span
        className={clsx(baseCls, 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400')}
        title={result.reason ?? 'Could not check the registry'}
      >
        <HelpCircle size={12} /> unknown
      </span>
    );
  }

  const palette = result.status === 'major'
    ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
    : result.status === 'minor'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';

  return (
    <button
      type="button"
      disabled={!canManage}
      onClick={onUpgrade}
      className={clsx(baseCls, palette, canManage ? 'cursor-pointer hover:brightness-95' : 'cursor-default')}
      title={`Latest: ${result.latest ?? '?'} (current ${result.current ?? '?'})`}
    >
      <ArrowUpCircle size={12} />
      {result.status} → {result.latest}
    </button>
  );
}
