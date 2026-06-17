import { KubeConfig } from '@kubernetes/client-node';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

/**
 * Annotation set on a tenant Deployment while a destructive storage op
 * (quiesce → shrink/restore) is holding it at replicas=0 to release the PVC.
 * `ensureFileManagerRunning` refuses to scale the file-manager back up while
 * this is present — otherwise the SFTP gateway / file routes, which call
 * ensureFileManagerRunning reactively, scale it back to 1 within ~2s and
 * fight quiesce (the pod keeps the PVC's RWO lock → waitForQuiesced timeout).
 * quiesce sets it; unquiesce (and the cancel/clear-failed valves) clear it.
 */
export const STORAGE_QUIESCED_ANNOTATION = 'insula.host/storage-quiesced';

/**
 * Reliable Deployment scaling — scale-to-0 was a silent no-op via the SDK.
 *
 * Two SDK paths both FAILED to scale a Deployment to 0 (proven live on
 * testing):
 *   • `patchNamespacedDeployment({ body: { spec: { replicas: 0 } } }, …)` —
 *     the `@kubernetes/client-node` v1.x ObjectSerializer omits
 *     `spec.replicas` when it's `0` (zero treated as an unset default), so
 *     the server gets `{ spec: {} }` and applies a no-op.
 *   • a Server-Side-Apply on the Deployment object — returned 2xx but never
 *     recorded the field-manager nor changed `spec.replicas` (no Apply owner
 *     appeared in managedFields).
 *
 * What DOES work (verified: `kubectl scale --replicas=0` sticks mid-op) is a
 * patch to the **`/scale` subresource**. So we do exactly that, as a raw
 * `application/merge-patch+json` request over node:https — the raw JSON body
 * `{"spec":{"replicas":0}}` never touches the SDK serializer, so `0` survives.
 * Throws on any non-2xx so a failed scale can never masquerade as success
 * (which is how quiesce previously hung at "Scaling workloads to zero": the
 * file-manager pod was never asked to terminate and kept the tenant PVC's
 * RWO lock until waitForQuiesced timed out).
 */
let cachedKc: KubeConfig | null = null;
function clusterKubeConfig(): KubeConfig {
  if (!cachedKc) {
    const kc = new KubeConfig();
    kc.loadFromCluster();
    cachedKc = kc;
  }
  return cachedKc;
}

export async function scaleDeploymentReplicas(
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  const kc = clusterKubeConfig();
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('scaleDeploymentReplicas: no current cluster in kubeconfig');
  const server = cluster.server.replace(/\/$/, '');
  const path = `/apis/apps/v1/namespaces/${namespace}/deployments/${encodeURIComponent(name)}/scale`;

  // Bearer token: kubeconfig user first, then the in-cluster ServiceAccount
  // token file (loadFromCluster wires it at request time, not into user.token).
  let token = kc.getCurrentUser()?.token;
  if (!token) {
    try { token = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim(); } catch { /* fall through */ }
  }
  if (!token) throw new Error('scaleDeploymentReplicas: no Bearer token (kubeconfig nor SA token file)');

  let ca: string | Buffer | undefined;
  if (cluster.caData) ca = Buffer.from(cluster.caData, 'base64');
  else if (cluster.caFile) ca = readFileSync(cluster.caFile);
  else if (!cluster.skipTLSVerify) {
    try { ca = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'); } catch { /* system CA may suffice */ }
  }

  const bodyBuf = Buffer.from(JSON.stringify({ spec: { replicas } }), 'utf8');
  const url = new URL(server + path);

  await new Promise<void>((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'PATCH',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        ca,
        rejectUnauthorized: !cluster.skipTLSVerify,
        headers: {
          'Content-Type': 'application/merge-patch+json',
          'Content-Length': String(bodyBuf.length),
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) { resolve(); return; }
          reject(new Error(
            `scaleDeploymentReplicas: ${namespace}/${name} scale->${replicas} HTTP ${status}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`,
          ));
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}
