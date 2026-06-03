import { z } from 'zod';

export const platformVersionResponseSchema = z.object({
  // Version spine (ADR-045): the three coordinates a consumer should read.
  //   installed — durable record of the release the cluster is on (DB row)
  //   running   — the live pod's version (platform-version ConfigMap → env)
  //   available — newest upstream release seen (null until the poller finds one)
  installed: z.string(),
  running: z.string(),
  available: z.string().nullable(),
  // Back-compat aliases retained for existing consumers: currentVersion === running,
  // latestVersion === available.
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  // Where latestVersion came from. 'none' means the upstream repo has no
  // GitHub releases AND no git tags yet — common on fresh installs. The UI
  // uses this to show a sensible message ("no releases published") instead
  // of an em-dash, and to pick the right CTA for auto-update environments.
  latestSource: z.enum(['releases', 'tags', 'none', 'unreachable']),
  updateAvailable: z.boolean(),
  environment: z.string(),
  autoUpdate: z.boolean(),
  imageUpdateStrategy: z.enum(['auto', 'manual']),
  pendingVersion: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  // W11 verified version-poller (ADR-045): `available` prefers the cosign-VERIFIED
  // value; these expose its provenance so the UI can distinguish a verified
  // available version from the unverified `latestVersion` fallback.
  //   availableVerifiedAt   — ISO timestamp of the last successful verify (null = none yet)
  //   availableVerifyStatus — last poll outcome: 'verified' | 'unsigned' |
  //                           'verify-failed' | 'invalid-manifest' | 'no-releases' (null = never polled)
  //   includePrereleases    — whether the poller considers prerelease tags
  availableVerifiedAt: z.string().nullable(),
  availableVerifyStatus: z.string().nullable(),
  includePrereleases: z.boolean(),
});

export const updateSettingsSchema = z.object({
  autoUpdate: z.boolean(),
  // Optional: when present, persists the poller's prerelease-inclusion flag.
  includePrereleases: z.boolean().optional(),
});

export const triggerUpdateResponseSchema = z.object({
  message: z.string(),
  targetVersion: z.string(),
});

export type PlatformVersionResponse = z.infer<typeof platformVersionResponseSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type TriggerUpdateResponse = z.infer<typeof triggerUpdateResponseSchema>;
