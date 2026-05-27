import IntegrationsSettings from '@/components/IntegrationsSettings';

/**
 * Platform → Integrations — operator-editable URLs the admin panel
 * embeds or links to (Longhorn, etc.).
 *
 * The IntegrationsSettings component already has its own heading +
 * Save flow; this thin page wrapper just gives it a routable home.
 */
export default function IntegrationsPage() {
  return (
    <div className="space-y-6">
      <IntegrationsSettings />
    </div>
  );
}
