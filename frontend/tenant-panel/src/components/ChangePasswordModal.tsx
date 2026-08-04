import { useState, useEffect, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useChangePassword } from '@/hooks/use-password';
import { ApiError } from '@/lib/api-client';

/**
 * Change-password dialog.
 *
 * Deliberately lives in its own module so it can be pulled in with `lazy()` —
 * the password inputs then ship in a separate chunk that is only fetched once
 * the user actually asks to change their password. Keeping them out of the
 * main bundle stops password managers from latching onto the fields on every
 * page load. Do not inline this back into Header.tsx.
 */

interface ChangePasswordModalProps {
  readonly onClose: () => void;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSuccessMessage('');
    setErrorMessage('');

    if (newPassword !== confirmPassword) {
      setErrorMessage('New passwords do not match');
      return;
    }

    try {
      await changePassword.mutateAsync({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setSuccessMessage('Password updated successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Failed to update password. Please try again.';
      setErrorMessage(message);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-password-modal-title"
      data-testid="change-password-modal"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        data-testid="user-menu-password-form"
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h2
            id="change-password-modal-title"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            Change Password
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Close"
            data-testid="password-form-back"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div>
            <label
              htmlFor="menu-current-password"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Current password
            </label>
            <input
              id="menu-current-password"
              type="password"
              autoComplete="current-password"
              className={INPUT_CLASS}
              data-testid="menu-current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="menu-new-password"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              New password
            </label>
            <input
              id="menu-new-password"
              type="password"
              autoComplete="new-password"
              className={INPUT_CLASS}
              data-testid="menu-new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="menu-confirm-password"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Confirm new password
            </label>
            <input
              id="menu-confirm-password"
              type="password"
              autoComplete="new-password"
              className={INPUT_CLASS}
              data-testid="menu-confirm-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          {successMessage && (
            <p className="text-xs text-green-600 dark:text-green-400" data-testid="menu-password-success">
              {successMessage}
            </p>
          )}
          {errorMessage && (
            <p className="text-xs text-red-600 dark:text-red-400" data-testid="menu-password-error">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 dark:border-gray-700 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            data-testid="menu-cancel-password-button"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={changePassword.isPending}
            className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid="menu-update-password-button"
          >
            {changePassword.isPending ? 'Updating...' : 'Update Password'}
          </button>
        </div>
      </form>
    </div>
  );
}
