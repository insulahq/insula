import { z } from 'zod';

/** How far back the mail-server memory graph reaches. */
export const MAIL_SERVER_MEMORY_WINDOW_HOURS = 168;

/** One bucket of the graph: the highest memory measured in that hour. */
export const mailServerMemoryPointSchema = z.object({
  /** Bucket end, epoch seconds. */
  t: z.number().int(),
  /** Null where nothing was measured (the server was down, or metrics were). */
  bytes: z.number().nonnegative().nullable(),
});
export type MailServerMemoryPoint = z.infer<typeof mailServerMemoryPointSchema>;

/**
 * GET /admin/mail/server/memory
 *
 * Stalwart's process memory against its container limit, for the card on
 * Email → Settings. "Process memory" is the container's anonymous memory
 * (cadvisor `container_memory_rss`): what the kernel OOM-kills on. RocksDB's
 * page cache is left out on purpose; it is charged to the same container but
 * is reclaimed before anything is killed.
 *
 * `available: false` means the metrics store holds no Stalwart series: mail
 * is not deployed, or the store has not collected it yet. `reason` then says
 * which, in operator words.
 */
export const mailServerMemoryResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  currentBytes: z.number().nonnegative().nullable(),
  limitBytes: z.number().nonnegative().nullable(),
  /** Highest hourly value in the window. */
  peakBytes: z.number().nonnegative().nullable(),
  /**
   * Share of the limit at which the `stalwart-memory-near-limit` alert fires
   * (operator override included). Null when that rule is disabled.
   */
  alertRatio: z.number().positive().nullable(),
  windowHours: z.number().int().positive(),
  stepSeconds: z.number().int().positive(),
  /** Oldest first. */
  points: z.array(mailServerMemoryPointSchema),
  /**
   * The running pod's last Stalwart kill for memory, if there was one.
   * `inferred` is a bare SIGKILL (exit 137) the kubelet did not label
   * OOMKilled, which it does not always do for a cgroup kill.
   */
  lastOomKill: z.object({
    at: z.string().datetime(),
    inferred: z.boolean(),
  }).nullable(),
});
export type MailServerMemoryResponse = z.infer<typeof mailServerMemoryResponseSchema>;
