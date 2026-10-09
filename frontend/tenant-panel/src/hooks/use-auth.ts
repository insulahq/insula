import { create } from 'zustand';
import { apiFetch, ApiError } from '@/lib/api-client';

interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly panel?: string;
  readonly tenantId?: string | null;
}

/**
 * Second step of a password sign-in. When the password is right but the
 * user has an authenticator app (TOTP) on, the backend returns
 * `requires_totp` and a short-lived pre-auth token instead of a session;
 * the Login page then asks for the 6-digit code (or a backup code).
 */
export interface TotpChallenge {
  readonly preAuthToken: string;
  readonly expiresIn: number;
  readonly user: AuthUser;
}

/** What proves the second factor: the live code, or one backup code. */
export type TotpProof = { readonly code: string } | { readonly backupCode: string };

/** The step token expired, was used, or is for the other panel: start over at the password. */
const RESTART_CODES = new Set(['PRE_AUTH_TOKEN_INVALID', 'PRE_AUTH_TOKEN_REPLAY', 'PRE_AUTH_TOKEN_PANEL_MISMATCH']);

interface AuthState {
  readonly token: string | null;
  readonly user: AuthUser | null;
  readonly isAuthenticated: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  /** Set after a right password when a code is still needed; cleared on success, cancel and every new password attempt. */
  readonly totpChallenge: TotpChallenge | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  initialize: () => void;
  setTokenAndUser: (token: string, user: AuthUser) => void;
  clearTotpChallenge: () => void;
  verifyTotp: (proof: TotpProof) => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  totpChallenge: null,

  initialize: () => {
    const token = localStorage.getItem('auth_token');
    const userJson = localStorage.getItem('auth_user');
    if (token && userJson) {
      try {
        const user = JSON.parse(userJson) as AuthUser;
        set({ token, user, isAuthenticated: true, isLoading: false });

        apiFetch<{ data: { id: string; email: string; fullName: string; role: string; tenantId?: string } }>('/api/v1/auth/me')
          .then((res) => {
            const freshUser = res.data;
            localStorage.setItem('auth_user', JSON.stringify(freshUser));
            set({ user: freshUser });
          })
          .catch((err: unknown) => {
            // ONLY a 401 is evidence that the token is bad. See the admin
            // panel's copy for the full reasoning — this one was worse: it
            // also dropped the REFRESH token, so a transient blip left no way
            // back at all.
            const status = (err as { status?: number } | null)?.status;
            if (status !== 401) return;
            try {
              localStorage.removeItem('auth_token');
              localStorage.removeItem('auth_refresh_token');
              localStorage.removeItem('auth_user');
            } catch { /* env torn down */ }
            set({ token: null, user: null, isAuthenticated: false, isLoading: false });
          });
      } catch {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_refresh_token');
        localStorage.removeItem('auth_user');
        set({ isLoading: false });
      }
    } else {
      set({ isLoading: false });
    }
  },

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null, totpChallenge: null });
    try {
      const res = await apiFetch<{
        data:
          | {
              token: string;
              refreshToken: string;
              expiresIn: number;
              refreshExpiresIn: number;
              user: AuthUser;
            }
          | {
              requires_totp: true;
              pre_auth_token: string;
              expires_in: number;
              user: AuthUser;
            };
      }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, panel: 'tenant' }),
      });

      if ('requires_totp' in res.data) {
        set({
          isLoading: false,
          totpChallenge: {
            preAuthToken: res.data.pre_auth_token,
            expiresIn: res.data.expires_in,
            user: res.data.user,
          },
        });
        return;
      }

      const { token, refreshToken, user } = res.data;
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_refresh_token', refreshToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      set({ token, user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Login failed. Please try again.';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    const refreshToken = localStorage.getItem('auth_refresh_token');
    if (refreshToken) {
      try {
        await apiFetch('/api/v1/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // best-effort
      }
    }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_refresh_token');
    localStorage.removeItem('auth_user');
    set({ token: null, user: null, isAuthenticated: false, error: null });
  },

  setTokenAndUser: (token: string, user: AuthUser) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true, isLoading: false, error: null, totpChallenge: null });
  },

  clearTotpChallenge: () => set({ totpChallenge: null, error: null }),

  verifyTotp: async (proof: TotpProof) => {
    const challenge = get().totpChallenge;
    if (!challenge) throw new Error('No sign-in step in progress');
    set({ isLoading: true, error: null });
    try {
      const res = await apiFetch<{ data: { token: string; refreshToken: string; user: AuthUser } }>('/api/v1/auth/totp/login/verify', {
        method: 'POST',
        body: JSON.stringify({
          pre_auth_token: challenge.preAuthToken,
          panel: 'tenant',
          ...('code' in proof ? { code: proof.code } : { backup_code: proof.backupCode }),
        }),
      });
      const { token, refreshToken, user } = res.data;
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_refresh_token', refreshToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      set({ token, user, isAuthenticated: true, isLoading: false, totpChallenge: null });
    } catch (err) {
      const restart = err instanceof ApiError && RESTART_CODES.has(err.code);
      set({
        isLoading: false,
        error: err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.',
        // A wrong code keeps the step (retype the code); an expired step goes back to the password.
        ...(restart ? { totpChallenge: null } : {}),
      });
      throw err;
    }
  },
}));
