import * as k8s from '@kubernetes/client-node';

export interface K8sClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
  readonly networking: k8s.NetworkingV1Api;
  readonly custom: k8s.CustomObjectsApi;
  readonly batch: k8s.BatchV1Api;
  readonly rbac: k8s.RbacAuthorizationV1Api;
  readonly storage: k8s.StorageV1Api;
  /** EndpointSlices — what traffic actually reaches, as opposed to what is Running. */
  readonly disco: k8s.DiscoveryV1Api;
}

/**
 * Create K8s API clients from a kubeconfig file path.
 * If no path is given, attempts in-cluster config (for production pods).
 */
export function createK8sClients(kubeconfigPath?: string): K8sClients {
  const kc = new k8s.KubeConfig();

  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
    // loadFromCluster() does NOT throw outside a cluster. With no service
    // account mounted it reads the unset KUBERNETES_SERVICE_HOST/PORT and
    // yields a cluster whose server is the literal 'https://undefined:undefined'
    // — a client that looks fine and then hangs on every request.
    //
    // Callers treat a throw as "no cluster here" and fall back (tenant DELETE
    // does a DB-only cascade, server.ts returns null). That fallback could
    // never fire, so off-cluster runs blocked on a dead socket instead of
    // taking the documented path.
    const server = kc.getCurrentCluster()?.server;
    if (!server || server.includes('undefined')) {
      throw new Error(
        'no usable Kubernetes config: not running in-cluster and no kubeconfig ' +
          'path was given (in-cluster discovery produced ' +
          `'${server ?? 'no server'}')`,
      );
    }
  }

  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api),
    storage: kc.makeApiClient(k8s.StorageV1Api),
    disco: kc.makeApiClient(k8s.DiscoveryV1Api),
  };
}
