import { useState, useEffect, type FormEvent } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useUpdateTenant } from '@/hooks/use-tenants';
import type { Tenant } from '@/types/api';

interface EditTenantModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly tenant: Tenant;
}

export default function EditTenantModal({ open, onClose, tenant }: EditTenantModalProps) {
  const [name, setCompanyName] = useState('');
  const [primaryEmail, setCompanyEmail] = useState('');
  const [secondaryEmail, setContactEmail] = useState('');

  const updateTenant = useUpdateTenant(tenant.id);

  useEffect(() => {
    if (open) {
      setCompanyName(tenant.name ?? '');
      setCompanyEmail(tenant.primaryEmail ?? '');
      setContactEmail(tenant.secondaryEmail ?? '');
      updateTenant.reset();
    }
  }, [open, tenant]);

  const handleClose = () => {
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateTenant.mutateAsync({
        name: name,
        primary_email: primaryEmail,
        secondary_email: secondaryEmail || undefined,
      });
      handleClose();
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="edit-tenant-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Tenant</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {updateTenant.error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="edit-error">
            {updateTenant.error instanceof Error ? updateTenant.error.message : 'Failed to update tenant'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="edit-tenant-form">
          <div>
            <label htmlFor="edit-company-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Company Name *
            </label>
            <input
              id="edit-company-name"
              type="text"
              required
              value={name}
              onChange={(e) => setCompanyName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="Acme Corp"
              data-testid="edit-company-name-input"
            />
          </div>

          <div>
            <label htmlFor="edit-company-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Company Email *
            </label>
            <input
              id="edit-company-email"
              type="email"
              required
              value={primaryEmail}
              onChange={(e) => setCompanyEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="admin@acme.com"
              data-testid="edit-company-email-input"
            />
          </div>

          <div>
            <label htmlFor="edit-contact-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Contact Email
            </label>
            <input
              id="edit-contact-email"
              type="email"
              value={secondaryEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="support@acme.com (optional)"
              data-testid="edit-contact-email-input"
            />
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
              disabled={updateTenant.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="edit-submit-button"
            >
              {updateTenant.isPending && <Loader2 size={14} className="animate-spin" />}
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
