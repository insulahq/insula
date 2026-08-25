import { z } from 'zod';

// Per-mailbox aliases — alternate addresses attached to an EXISTING
// mailbox. Mail to the alias is delivered into the mailbox, and the
// mailbox owner can send AS the alias (Stalwart account-level `aliases`
// map + a platform-pushed JMAP Identity; enforcement is server-side).
//
// Distinct from email-aliases (Stalwart MailingLists): those are
// mailbox-less forwarding addresses with 1..N destinations. A mailbox
// alias has exactly one destination — its mailbox — and adds send-as.
//
// Aliases do not count against any plan quota (operator decision
// 2026-08-25).

// Same local-part shape as mailbox creation.
export const mailboxAliasLocalPartSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid alias name');

export const createMailboxAliasSchema = z.object({
  local_part: mailboxAliasLocalPartSchema,
});

export type CreateMailboxAliasInput = z.infer<typeof createMailboxAliasSchema>;

export const updateMailboxAliasSchema = z.object({
  // Disabling stops BOTH directions on the mail server: inbound to the
  // alias is rejected (550) and sending as the alias is refused (501).
  enabled: z.boolean(),
});

export type UpdateMailboxAliasInput = z.infer<typeof updateMailboxAliasSchema>;

export const mailboxAliasResponseSchema = z.object({
  id: z.string(),
  mailboxId: z.string(),
  emailDomainId: z.string(),
  tenantId: z.string(),
  localPart: z.string(),
  fullAddress: z.string(),
  enabled: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MailboxAliasResponse = z.infer<typeof mailboxAliasResponseSchema>;
