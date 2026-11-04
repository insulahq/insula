import { z } from 'zod';

// ─── Outbound mail ports ─────────────────────────────────────────────────────
//
// Can a node open TCP 25, 465 and 587 to the internet? Some hosting providers
// block outbound mail ports on a server (often a newly ordered one). Nothing on
// the node shows it — its firewall lets the traffic out and the provider drops
// it — so every send from the node times out: a tenant app's mail, and on a
// mail node the mail server's own delivery. Measured from each node's own
// network by the security-probe DaemonSet (images/security-probe/outboundmail.go,
// published at data.outboundMail of security-probe-<node>), and once before
// install by bootstrap.sh's preflight, against the same public mail servers.
//
//   open     a target accepted a TCP connection (closed at once; no SMTP)
//   blocked  targets resolved, none accepted (timed out, refused, unreachable)
//   unknown  no target resolved — that says nothing about the port

/** Mail servers deliver to other mail servers on this port. */
export const OUTBOUND_MAIL_DELIVERY_PORT = 25;
/** Apps submit mail to a mail server on these (implicit TLS, STARTTLS). */
export const OUTBOUND_MAIL_SUBMISSION_PORTS: readonly number[] = [465, 587];

export const outboundMailPortStatusSchema = z.enum(['open', 'blocked', 'unknown']);
export type OutboundMailPortStatus = z.infer<typeof outboundMailPortStatusSchema>;

/** One port as the probe publishes it — MUST match OutboundMailPortWire. */
export const outboundMailProbePortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  status: outboundMailPortStatusSchema,
  /** The target that accepted (open only). */
  target: z.string().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  /** What each target answered, when none accepted. */
  detail: z.string().nullable(),
});
export type OutboundMailProbePort = z.infer<typeof outboundMailProbePortSchema>;

/** The probe's data.outboundMail — MUST match OutboundMailWire. */
export const outboundMailProbeSchema = z.object({
  checkedAt: z.string().datetime(),
  intervalSeconds: z.number().int().positive(),
  ports: z.array(outboundMailProbePortSchema),
});
export type OutboundMailProbe = z.infer<typeof outboundMailProbeSchema>;

/** One port as node health and mail health report it. */
export const outboundMailPortSchema = outboundMailProbePortSchema.extend({
  /**
   * The node needs this port: 465 and 587 on every node (apps on it submit
   * mail), 25 on a mail node (the mail server delivers from it). A blocked port
   * that is not required is shown, not judged.
   */
  required: z.boolean(),
});
export type OutboundMailPort = z.infer<typeof outboundMailPortSchema>;

/** A node's outbound mail ports in node health. */
export const nodeOutboundMailSchema = z.object({
  checkedAt: z.string().datetime(),
  /** How often the probe checks — a stored result is re-judged for staleness against it. */
  intervalSeconds: z.number().int().positive(),
  /**
   * The probe has not reported for three of its intervals (it is down, or the
   * node is). Its last result is shown but no longer judged.
   */
  stale: z.boolean(),
  ports: z.array(outboundMailPortSchema),
});
export type NodeOutboundMail = z.infer<typeof nodeOutboundMailSchema>;
