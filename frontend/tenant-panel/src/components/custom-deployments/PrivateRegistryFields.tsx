// Create-time registry credential, shared by the simple wizard and the
// compose editor.
//
// Before this existed, a private image could not be deployed on the first
// attempt: the credential is stored against a deployment id, so nothing could
// be saved until the deployment already existed. The flow was create → watch
// it fail with ImagePullBackOff → open the registry modal → redeploy. The
// wizard's own Image tooltip documented that detour.
//
// `PrivateRegistryPanel` still handles rotate/revoke on an EXISTING
// deployment; this is only the create path.

import { KeyRound } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

export interface PullCredentialDraft {
  readonly registryHost: string;
  readonly username: string;
  readonly token: string;
}

export const EMPTY_PULL_CREDENTIAL: PullCredentialDraft = {
  registryHost: '',
  username: '',
  token: '',
};

/**
 * A draft is submittable only when all three fields are filled. Half-filled is
 * a user error worth blocking on, because a partially-specified credential
 * silently becomes "no credential" and the tenant gets the exact
 * ImagePullBackOff this feature removes.
 */
export function pullCredentialComplete(d: PullCredentialDraft): boolean {
  return Boolean(d.registryHost.trim() && d.username.trim() && d.token);
}

export function pullCredentialPartial(d: PullCredentialDraft): boolean {
  const filled = [d.registryHost.trim(), d.username.trim(), d.token].filter(Boolean).length;
  return filled > 0 && filled < 3;
}

/** Map the draft onto the api-contracts create-body shape. */
export function toPullCredentialInput(d: PullCredentialDraft) {
  return { registry_host: d.registryHost.trim(), username: d.username.trim(), token: d.token };
}

interface Props {
  readonly enabled: boolean;
  readonly onEnabledChange: (v: boolean) => void;
  readonly value: PullCredentialDraft;
  readonly onChange: (v: PullCredentialDraft) => void;
  /** Shown under the fields — e.g. the partial-fill warning. */
  readonly error?: string | null;
}

export function PrivateRegistryFields({ enabled, onEnabledChange, value, onChange, error }: Props) {
  return (
    <section>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          data-testid="custom-private-registry-toggle"
        />
        <KeyRound size={14} className="text-gray-500 dark:text-gray-400" />
        This image is in a private registry
        <Tooltip text="Supply the credentials now and the very first pull will work. Leave unchecked for public images (Docker Hub, ghcr.io public packages). You can add, rotate or revoke a credential later from the deployment's registry-key button." />
      </label>

      {enabled && (
        <div className="mt-3 space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center gap-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Registry host</label>
                <Tooltip text="Hostname of your container registry (e.g. ghcr.io, docker.io, registry.example.com:5000). No scheme, no path. The credential is scoped to this host." />
              </div>
              <input
                type="text"
                value={value.registryHost}
                onChange={(e) => onChange({ ...value, registryHost: e.target.value })}
                placeholder="ghcr.io"
                className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                data-testid="custom-private-registry-host"
              />
            </div>
            <div>
              <div className="flex items-center gap-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Username</label>
                <Tooltip text="Your registry account username, GitHub handle, or robot/service-account name." />
              </div>
              <input
                type="text"
                value={value.username}
                onChange={(e) => onChange({ ...value, username: e.target.value })}
                placeholder="my-github-handle"
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                data-testid="custom-private-registry-username"
              />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1">
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Token (PAT)</label>
              <Tooltip text="A Personal Access Token or robot password with at least read access to the package. Stored AES-256 encrypted at rest and never returned in full — only the last 4 characters are shown afterwards." />
            </div>
            <input
              type="password"
              value={value.token}
              onChange={(e) => onChange({ ...value, token: e.target.value })}
              placeholder="ghp_…"
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              data-testid="custom-private-registry-token"
            />
            <span className="mt-1 block text-[10px] text-gray-500 dark:text-gray-400">
              Never logged. The image is verified with this token before the deployment is created.
            </span>
          </div>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </section>
  );
}
