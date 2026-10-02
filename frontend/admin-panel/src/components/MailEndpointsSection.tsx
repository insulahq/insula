/**
 * "What was tested" table for the mail-health drill-down.
 *
 * Renders the mail endpoint set the backend ran every per-node / per-address
 * check against (placement + port-exposure mode → the nodes that publish the
 * mail ports, with their IPv4/IPv6), the per-endpoint port-exposure result,
 * and the placement nodes that were deliberately NOT tested (standby) with
 * the reason. A node that is neither does not appear — by design.
 */

import { CheckCircle2, AlertTriangle, MinusCircle } from 'lucide-react';
import type {
  MailEndpointNode,
  MailEndpointSet,
  MailHealthExposureComponent,
  MailHealthExposureNode,
  MailUntestedNode,
} from '@insula/api-contracts';

interface MailEndpointsSectionProps {
  readonly endpoints: MailEndpointSet;
  readonly exposure: MailHealthExposureComponent | undefined;
}

const ACTIVE_SOURCE_LABEL: Record<NonNullable<MailEndpointSet['activeNodeSource']>, string> = {
  pod: 'running Stalwart pod',
  settings: 'stored active node',
  primary: 'primary (no pod running)',
  sole_node: 'only node in the cluster',
};

const EXPOSURE_LABEL: Record<MailEndpointNode['exposure'], string> = {
  hostPort: 'Stalwart hostPort',
  haproxy: 'haproxy',
};

export default function MailEndpointsSection({ endpoints, exposure }: MailEndpointsSectionProps) {
  const exposureByNode = new Map((exposure?.nodes ?? []).map((n) => [n.node, n]));
  return (
    <div className="space-y-2" data-testid="mail-endpoints-section">
      <div className="text-xs text-gray-600 dark:text-gray-400">
        Port exposure <span className="font-mono text-gray-800 dark:text-gray-200">{endpoints.mode}</span>
        {' • '}active node{' '}
        <span className="font-mono text-gray-800 dark:text-gray-200">{endpoints.activeNode ?? 'none'}</span>
        {endpoints.activeNodeSource && <> ({ACTIVE_SOURCE_LABEL[endpoints.activeNodeSource]})</>}
        {' • '}ports <span className="font-mono">{endpoints.ports.join(', ')}</span>
      </div>
      <div className="rounded-md border border-gray-200 dark:border-gray-700 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Node</th>
              <th className="text-left px-3 py-1.5 font-medium">Role</th>
              <th className="text-left px-3 py-1.5 font-medium">Publishes via</th>
              <th className="text-left px-3 py-1.5 font-medium">IPv4</th>
              <th className="text-left px-3 py-1.5 font-medium">IPv6</th>
              <th className="text-left px-3 py-1.5 font-medium">Mail ports</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {endpoints.endpoints.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-2 text-amber-700 dark:text-amber-300">
                  No node publishes the mail ports under the current placement and port exposure.
                </td>
              </tr>
            )}
            {endpoints.endpoints.map((e) => (
              <EndpointRow key={e.node} endpoint={e} exposure={exposureByNode.get(e.node)} />
            ))}
            {endpoints.untested.map((u) => <UntestedRow key={`untested-${u.node}`} node={u} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function roleLabel(roles: ReadonlyArray<string>, active: boolean): string {
  const parts = [...roles];
  if (active) parts.push('active');
  return parts.length > 0 ? parts.join(', ') : '—';
}

function addressOf(e: MailEndpointNode, family: 'ipv4' | 'ipv6'): string | null {
  return e.addresses.find((a) => a.family === family)?.address ?? null;
}

function EndpointRow({ endpoint, exposure }: { readonly endpoint: MailEndpointNode; readonly exposure: MailHealthExposureNode | undefined }) {
  const v4 = addressOf(endpoint, 'ipv4');
  const v6 = addressOf(endpoint, 'ipv6');
  return (
    <tr data-testid={`mail-endpoint-${endpoint.node}`}>
      <td className="px-3 py-1.5 font-mono text-gray-800 dark:text-gray-200">{endpoint.node}</td>
      <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">{roleLabel(endpoint.roles, endpoint.active)}</td>
      <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">{EXPOSURE_LABEL[endpoint.exposure]}</td>
      <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">{v4 ?? <span className="text-gray-400 dark:text-gray-500">none</span>}</td>
      <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">{v6 ?? <span className="text-gray-400 dark:text-gray-500">none</span>}</td>
      <td className="px-3 py-1.5"><ExposureCell exposure={exposure} /></td>
    </tr>
  );
}

function ExposureCell({ exposure }: { readonly exposure: MailHealthExposureNode | undefined }) {
  if (!exposure) return <span className="text-gray-400 dark:text-gray-500">not checked</span>;
  const published = exposure.ports.filter((p) => p.published).length;
  if (exposure.error === null) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 size={12} /> {published}/{exposure.ports.length} published
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1 text-red-700 dark:text-red-400">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>{published}/{exposure.ports.length} published — {exposure.error}</span>
    </span>
  );
}

function UntestedRow({ node }: { readonly node: MailUntestedNode }) {
  const label = node.reason === 'standby' ? 'Not tested — standby' : 'Not tested — not in cluster';
  return (
    <tr className="bg-gray-50/60 dark:bg-gray-900/20" data-testid={`mail-untested-${node.node}`}>
      <td className="px-3 py-1.5 font-mono text-gray-500 dark:text-gray-400">{node.node}</td>
      <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">{roleLabel(node.roles, false)}</td>
      <td colSpan={4} className="px-3 py-1.5 text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-start gap-1">
          <MinusCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium text-gray-600 dark:text-gray-300">{label}.</span> {node.detail}
          </span>
        </span>
      </td>
    </tr>
  );
}
