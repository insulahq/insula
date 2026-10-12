/**
 * The name of a running mail server pod, or null when there is none.
 *
 * The API server filters by phase. Listing by label with `limit: 1` and then
 * looking for a running pod in what came back finds none whenever a finished
 * pod sorts first — and finished mail pods stay behind after every node
 * restart, until the cluster's pod garbage collection gets to them. The mail
 * storage figures in the admin panel read "—" for as long as one did.
 */
import type { CoreV1Api } from '@kubernetes/client-node';

const MAIL_NAMESPACE = 'mail';
const STALWART_POD_SELECTOR = 'app=stalwart-mail';

export type PodLister = Pick<CoreV1Api, 'listNamespacedPod'>;

export async function findRunningStalwartPod(core: PodLister): Promise<string | null> {
  const pods = await core.listNamespacedPod({
    namespace: MAIL_NAMESPACE,
    labelSelector: STALWART_POD_SELECTOR,
    fieldSelector: 'status.phase=Running',
  });
  // The phase is checked again here: a list answer is only as filtered as the
  // server that produced it, and this costs nothing. A pod that is being
  // deleted still reads Running, so one that is staying goes first.
  const running = (pods.items ?? []).filter((p) => p.status?.phase === 'Running');
  const pod = running.find((p) => !p.metadata?.deletionTimestamp) ?? running[0];
  return pod?.metadata?.name ?? null;
}

interface PodLike {
  readonly metadata?: {
    readonly creationTimestamp?: Date | string;
    readonly deletionTimestamp?: Date | string;
  };
  readonly status?: { readonly phase?: string };
}

const createdAtMs = (p: PodLike): number => {
  const t = p.metadata?.creationTimestamp;
  const ms = t ? new Date(t).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * The pod a Deployment currently stands on, out of everything its label
 * selects — for code that reports on that pod whatever state it is in.
 *
 * A finished pod (Succeeded or Failed) is never it, wherever it sorts. A pod
 * that is being deleted is it only when nothing else is left. The newest wins
 * within each group. Undefined when every pod in the list is finished.
 */
export function pickCurrentPod<T extends PodLike>(items: readonly T[]): T | undefined {
  const live = items.filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed');
  const newestFirst = (a: T, b: T): number => createdAtMs(b) - createdAtMs(a);
  const staying = live.filter((p) => !p.metadata?.deletionTimestamp);
  return [...staying].sort(newestFirst)[0] ?? [...live].sort(newestFirst)[0];
}
