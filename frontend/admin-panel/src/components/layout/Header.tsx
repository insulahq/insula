import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { Menu, Search, UserCircle, KeyRound, LogOut, Settings } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import NotificationDropdown from '@/components/NotificationDropdown';
import DarkModeToggle from '@/components/DarkModeToggle';
import TaskCenterChip from '@/components/TaskCenterChip';

// Lazy on purpose: the password inputs must not be part of the main bundle, or
// password-manager extensions pick them up on every page load. The chunk is
// only fetched when the operator opens the dialog.
const ChangePasswordModal = lazy(() => import('@/components/ChangePasswordModal'));

interface HeaderProps {
  readonly onMenuClick: () => void;
}

export default function Header({ onMenuClick }: HeaderProps) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const handleToggle = () => {
    setMenuOpen((prev) => !prev);
  };

  const handleOpenPasswordModal = () => {
    setMenuOpen(false);
    setPasswordModalOpen(true);
  };

  const handleSignOut = async () => {
    setMenuOpen(false);
    await logout();
  };

  return (
    <header className="flex h-16 items-center gap-4 border-b border-gray-200 bg-white px-4 lg:px-6 dark:border-gray-700 dark:bg-gray-800">
      <button
        onClick={onMenuClick}
        className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 lg:hidden dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        aria-label="Open menu"
        data-testid="menu-button"
      >
        <Menu size={20} />
      </button>

      <div className="relative flex-1 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
        {/* See the tenant panel's Header for the full reasoning: this input
            is on EVERY page, and an anonymous input (no name, no id, no
            autocomplete) on an origin with a saved login is what makes
            password managers offer to fill on every page. `disabled` does
            not stop them from decorating it. Keep these attributes on any
            always-visible input we add. */}
        <input
          type="search"
          id="global-search"
          name="global-search"
          aria-label="Search"
          placeholder="Search (coming soon)"
          disabled
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          data-testid="global-search-input"
          className="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:bg-gray-700 cursor-not-allowed opacity-50"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <TaskCenterChip />
        <DarkModeToggle />
        <NotificationDropdown />

        <div className="relative" ref={menuRef}>
          <button
            onClick={handleToggle}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="User menu"
            data-testid="user-menu-button"
          >
            <UserCircle size={20} />
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-gray-200 bg-white shadow-lg z-50 dark:border-gray-700 dark:bg-gray-800"
              data-testid="user-menu-dropdown"
            >
              <div className="border-b border-gray-100 p-4 dark:border-gray-700">
                <p className="font-medium text-gray-900 dark:text-gray-100" data-testid="user-menu-name">
                  {user?.fullName ?? 'User'}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="user-menu-email">
                  {user?.email ?? ''}
                </p>
              </div>

              <div className="p-2">
                <Link
                  to="/user-settings"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                  data-testid="user-settings-menu-item"
                >
                  <Settings size={16} />
                  Settings
                </Link>
                <button
                  onClick={handleOpenPasswordModal}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                  data-testid="change-password-menu-item"
                >
                  <KeyRound size={16} />
                  Change Password
                </button>
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                <button
                  onClick={handleSignOut}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                  data-testid="user-menu-sign-out"
                >
                  <LogOut size={16} />
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {passwordModalOpen && (
        <Suspense fallback={null}>
          <ChangePasswordModal onClose={() => setPasswordModalOpen(false)} />
        </Suspense>
      )}
    </header>
  );
}
