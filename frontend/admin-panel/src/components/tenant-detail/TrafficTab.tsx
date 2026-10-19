/**
 * Tenant → Traffic: Monitoring → Traffic, narrowed to this tenant.
 *
 * The same component — range picker, breakdowns, chart, stats and table — so
 * the two read alike and change together. Above it, the one thing that is
 * this tenant's alone: how much of its monthly allowance is used.
 */
import { Link } from 'react-router-dom';
import type { Tenant } from '@/types/api';
import TrafficTab from '@/components/traffic/TrafficTab';
import { trafficTabUrl } from '@/components/traffic/traffic-url';
import { useTenantBandwidth } from '@/hooks/use-tenant-insights';
import { Card, GoLink, Meter, formatGb } from './ui';
import { bandwidthForecast } from './bandwidth-forecast';

export default function TenantTrafficTab({ tenant, tenantId }: { readonly tenant: Tenant; readonly tenantId: string }) {
  const { data: bwRes } = useTenantBandwidth(tenantId);
  const bw = bwRes?.data;
  const forecast = bw ? bandwidthForecast(bw, new Date()) : null;
  const namespace = tenant.kubernetesNamespace;

  return (
    <div className="space-y-4" data-testid="tenant-traffic">
      {bw && bw.limitGb > 0 && (
        <Link
          to={`/tenants/${tenantId}/limits`}
          className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-gray-200 bg-white px-5 py-3 shadow-sm hover:border-brand-500 hover:ring-1 hover:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
          data-testid="tenant-bandwidth-strip"
        >
          <span className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">Bandwidth this cycle</span>
          <span className="text-[13px] text-gray-900 dark:text-gray-100"><strong>{formatGb(bw.usedGb)}</strong> <span className="text-gray-500 dark:text-gray-400">of {formatGb(bw.limitGb, 0)}</span></span>
          <span className="w-full max-w-sm flex-[1_1_200px]"><Meter pct={bw.usedPct} /></span>
          {(bw.capped || forecast) && (
            <span className="text-xs text-amber-700 dark:text-amber-400">{bw.capped ? 'Capped: the allowance is used up' : forecast}</span>
          )}
          <span className="ml-auto text-[13px] font-medium text-brand-600 dark:text-brand-400">Plan &amp; limits →</span>
        </Link>
      )}

      {namespace ? (
        <Card
          title="Traffic"
          actions={<GoLink to={trafficTabUrl({ scope: 'tenant', subject: namespace })}>Open in Monitoring → Traffic</GoLink>}
          bodyClassName=""
        >
          <TrafficTab tenant={{ id: tenantId, namespace }} />
        </Card>
      ) : (
        <Card><p className="text-sm text-gray-600 dark:text-gray-400">This tenant has no namespace yet, so there is no traffic to show.</p></Card>
      )}
    </div>
  );
}
