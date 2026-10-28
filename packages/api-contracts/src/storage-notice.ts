import { z } from 'zod';

/**
 * What the tenant panel's account banner says about storage — decided on the
 * server, from the operation behind the state and what is actually down.
 *
 * The bare `storageLifecycleState` cannot say it. `failed` is left behind both
 * by a resize or restore that broke halfway (storage changes are on hold until
 * an operator resolves it) and by an automatic restart that could not bring an
 * application back (nothing is running, the application is down). The banner
 * used to answer both with "until the operation completes", which is true of
 * neither.
 */
export const storageOperationTypeEnum = z.enum([
  'snapshot', 'resize', 'suspend', 'resume', 'archive', 'restore', 'fsck', 'autoheal', 'relocate',
]);
export type StorageOperationType = z.infer<typeof storageOperationTypeEnum>;

export const tenantStorageNoticeSchema = z.discriminatedUnion('kind', [
  /** An operation is running now. `opType` is null when its row cannot be read. */
  z.object({
    kind: z.literal('operation_running'),
    opType: storageOperationTypeEnum.nullable(),
  }),
  /**
   * An automatic restart could not bring these workloads back; nothing is
   * running. Names are what the tenant sees on its Applications page, or a
   * plain label for a platform component.
   */
  z.object({
    kind: z.literal('workloads_down'),
    workloads: z.array(z.string()).min(1),
  }),
  /** An operation stopped partway; storage changes wait for an operator. */
  z.object({
    kind: z.literal('operation_failed'),
    opType: storageOperationTypeEnum.nullable(),
  }),
]);
export type TenantStorageNotice = z.infer<typeof tenantStorageNoticeSchema>;
