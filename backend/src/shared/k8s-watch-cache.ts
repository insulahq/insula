/**
 * Cluster-wide Pods and Deployments, kept current by a WATCH instead of being
 * re-LISTed by every poller.
 *
 * The status reconciler listed every Pod and every Deployment in the cluster
 * every 15 s, and the node sync, auto-repin and placement loops each listed
 * every Pod again every minute. On a production cluster a Pod list was ~270 KB,
 * so those lists alone moved gigabytes a day between the nodes (the
 * apiserver answering is usually on another node). A watch sends only what
 * changed.
 *
 * ## Same objects as a LIST
 * The watch delivers raw JSON, while the typed LIST the callers use today
 * returns deserialized models (Dates for timestamps, reserved words renamed —
 * see the client's ObjectSerializer). `@kubernetes/client-node`'s own informer
 * mixes the two shapes in one cache. This one deserializes every watch event
 * with the same serializer the LIST path uses, so a caller cannot tell which
 * path served it — that is what makes it a drop-in.
 *
 * ## Never a precondition
 * `list()` answers only while the cache is synced and its watch is healthy;
 * otherwise the caller's LIST runs exactly as before. A watch error, a 410
 * Gone, or a missed relist degrades to the old behaviour, never to stale data:
 * an error marks the cache unhealthy until a full relist succeeds, and a full
 * relist also runs every RESYNC_MS as a backstop.
 *
 * The returned array is fresh, but the objects in it are SHARED with the cache.
 * Callers must treat them as read-only (every current caller does).
 */
import * as k8s from '@kubernetes/client-node';
// Not re-exported from the package index; the package has no `exports` map, so
// the deep path resolves. `k8s-watch-cache.test.ts` pins that it still does.
import { ObjectSerializer } from '@kubernetes/client-node/dist/gen/models/ObjectSerializer.js';
import type { K8sClients } from '../modules/k8s-provisioner/k8s-client.js';

const RESYNC_MS = 30 * 60_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

interface ListShape<T> {
  readonly items?: T[];
  readonly metadata?: { readonly resourceVersion?: string };
}

interface WatchLike {
  watch(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    onEvent: (phase: string, obj: unknown) => void,
    onDone: (err: unknown) => void,
  ): Promise<{ abort(): void }>;
}

export interface WatchCacheOptions<T> {
  /** API path to watch, e.g. `/api/v1/pods`. */
  readonly path: string;
  /** Model type name the client's serializer knows, e.g. `V1Pod`. */
  readonly modelType: string;
  /** The typed LIST that seeds (and re-seeds) the cache. */
  readonly list: () => Promise<ListShape<T>>;
  readonly watcher: WatchLike;
  readonly log?: { warn: (msg: string) => void };
  readonly now?: () => number;
}

function keyOf(obj: { metadata?: { namespace?: string; name?: string } } | undefined): string | null {
  const name = obj?.metadata?.name;
  return name ? `${obj?.metadata?.namespace ?? ''}/${name}` : null;
}

export class WatchCache<T extends { metadata?: { namespace?: string; name?: string } }> {
  private readonly objects = new Map<string, T>();
  private resourceVersion = '';
  private synced = false;
  private healthy = false;
  private started = false;
  private stopped = false;
  private lastFullList = 0;
  private retryMs = RETRY_MIN_MS;
  private request: { abort(): void } | null = null;
  private timer: NodeJS.Timeout | null = null;
  /**
   * Bumped whenever a watch is replaced. Aborting a watch fires its done
   * callback; without this, that callback would schedule a relist, which
   * aborts the next watch, and so on.
   */
  private generation = 0;

  constructor(private readonly opts: WatchCacheOptions<T>) {}

  /** Current objects, or null when the cache cannot vouch for them. */
  list(): T[] | null {
    if (!this.synced || !this.healthy) return null;
    if ((this.opts.now?.() ?? Date.now()) - this.lastFullList > RESYNC_MS) {
      // Backstop: relist on the next turn, keep serving meanwhile (the watch is healthy).
      this.scheduleRelist(0);
    }
    return [...this.objects.values()];
  }

  /** Start once; safe to call on every use. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleRelist(0);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.request?.abort();
    this.request = null;
  }

  private scheduleRelist(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.relist(); }, delayMs);
    this.timer.unref?.();
  }

  private async relist(): Promise<void> {
    this.generation += 1;
    this.request?.abort();
    this.request = null;
    try {
      const res = await this.opts.list();
      this.objects.clear();
      for (const item of res.items ?? []) {
        const key = keyOf(item);
        if (key) this.objects.set(key, item);
      }
      this.resourceVersion = res.metadata?.resourceVersion ?? '';
      this.lastFullList = this.opts.now?.() ?? Date.now();
      this.synced = true;
      this.healthy = true;
      this.retryMs = RETRY_MIN_MS;
      await this.watch();
    } catch (err) {
      this.fail(err);
    }
  }

  private async watch(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    const request = await this.opts.watcher.watch(
      this.opts.path,
      { resourceVersion: this.resourceVersion, allowWatchBookmarks: true },
      (phase, raw) => { if (gen === this.generation) this.onEvent(phase, raw); },
      (err) => { if (gen === this.generation) this.onDone(err); },
    );
    if (gen === this.generation) this.request = request;
    else request.abort();
  }

  private onEvent(phase: string, raw: unknown): void {
    const rv = (raw as { metadata?: { resourceVersion?: string } } | null)?.metadata?.resourceVersion;
    switch (phase) {
      case 'ADDED':
      case 'MODIFIED': {
        const obj = ObjectSerializer.deserialize(raw, this.opts.modelType, '') as T;
        const key = keyOf(obj);
        if (key) this.objects.set(key, obj);
        break;
      }
      case 'DELETED': {
        const key = keyOf(raw as T);
        if (key) this.objects.delete(key);
        break;
      }
      case 'BOOKMARK':
        break;
      case 'ERROR':
        // e.g. 410 Gone: our resourceVersion is too old. The stream ends next;
        // until the relist lands the cache must not answer.
        this.healthy = false;
        this.resourceVersion = '';
        return;
      default:
        return;
    }
    if (rv) this.resourceVersion = rv;
  }

  private onDone(err: unknown): void {
    this.request = null;
    if (this.stopped) return;
    if (err || !this.healthy || !this.resourceVersion) {
      this.fail(err ?? new Error('watch ended without a resumable resourceVersion'));
      return;
    }
    // A normal server-side close (watches time out): resume where we were.
    this.watch().catch((e: unknown) => this.fail(e));
  }

  private fail(err: unknown): void {
    this.healthy = false;
    const msg = err instanceof Error ? err.message : String(err);
    this.opts.log?.warn(`[k8s-watch-cache] ${this.opts.path}: ${msg} — falling back to LIST, retrying in ${this.retryMs} ms`);
    this.scheduleRelist(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }
}

// ─── process-wide caches for the cluster-wide lists the pollers share ────────

const caches = new Map<string, WatchCache<never>>();

function cacheFor<T extends { metadata?: { namespace?: string; name?: string } }>(
  k8sClients: K8sClients,
  path: string,
  modelType: string,
  list: () => Promise<ListShape<T>>,
): WatchCache<T> | null {
  const kc = k8sClients.kubeConfig;
  const server = kc?.getCurrentCluster()?.server;
  if (!kc || !server) return null; // a test double or an off-cluster run: no cache
  const key = `${server}|${path}`;
  let cache = caches.get(key) as unknown as WatchCache<T> | undefined;
  if (!cache) {
    cache = new WatchCache<T>({
      path, modelType, list,
      watcher: new k8s.Watch(kc) as unknown as WatchLike,
      log: console,
    });
    caches.set(key, cache as unknown as WatchCache<never>);
    cache.start();
  }
  return cache;
}

/** Every Pod in the cluster — from the watch cache when it is current, else a LIST. */
export async function listPodsCached(k8sClients: K8sClients): Promise<{ items: k8s.V1Pod[] }> {
  const cache = cacheFor<k8s.V1Pod>(k8sClients, '/api/v1/pods', 'V1Pod',
    () => k8sClients.core.listPodForAllNamespaces());
  const cached = cache?.list();
  if (cached) return { items: cached };
  const res = await k8sClients.core.listPodForAllNamespaces();
  return { items: res.items ?? [] };
}

/** Every Deployment in the cluster — from the watch cache when it is current, else a LIST. */
export async function listDeploymentsCached(k8sClients: K8sClients): Promise<{ items: k8s.V1Deployment[] }> {
  const cache = cacheFor<k8s.V1Deployment>(k8sClients, '/apis/apps/v1/deployments', 'V1Deployment',
    () => k8sClients.apps.listDeploymentForAllNamespaces());
  const cached = cache?.list();
  if (cached) return { items: cached };
  const res = await k8sClients.apps.listDeploymentForAllNamespaces();
  return { items: res.items ?? [] };
}

/** Stop every watch (shutdown, tests). */
export function stopWatchCaches(): void {
  for (const c of caches.values()) c.stop();
  caches.clear();
}
