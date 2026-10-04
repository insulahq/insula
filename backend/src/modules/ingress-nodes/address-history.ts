import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { addressKey } from '../../shared/ip-address.js';

/**
 * Every address that has ever been a server's public address, and whose it
 * was — kept after the server is gone.
 *
 * Removing a server deletes its `cluster_nodes` row, so without this the
 * platform forgets which IP it had. A route's A record still pointing at that
 * IP then looks like an address the operator added by hand, and the DNS drift
 * repair — which never touches what it cannot attribute — would leave every
 * tenant sending visitors to a server that no longer exists.
 *
 * Keyed `A|<ip>` / `AAAA|<ip>`; `server` is the raw node name, or null for an
 * operator-override address that belonged to no node (a load-balancer VIP).
 */
export const ADDRESS_HISTORY_KEY = 'ingress_address_history';

export interface AddressHistoryEntry {
  readonly server: string | null;
  readonly lastSeenAt: string;
}
export type AddressHistory = Readonly<Record<string, AddressHistoryEntry>>;

const REFRESH_MS = 24 * 60 * 60 * 1000;

export const historyKey = addressKey;

export async function readAddressHistory(db: Database): Promise<AddressHistory> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, ADDRESS_HISTORY_KEY));
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as AddressHistory) : {};
  } catch {
    return {};
  }
}

/**
 * Merge sightings into the history. A server sighting replaces an earlier
 * owner of the same address (IPs are reassigned); a null-server sighting (an
 * override address) never erases a known server.
 */
export function mergeAddressHistory(
  current: AddressHistory,
  sightings: ReadonlyArray<{ readonly type: 'A' | 'AAAA'; readonly address: string; readonly server: string | null }>,
  at: Date,
): AddressHistory {
  const next: Record<string, AddressHistoryEntry> = { ...current };
  for (const s of sightings) {
    const key = historyKey(s.type, s.address);
    const prev = next[key];
    const server = s.server ?? prev?.server ?? null;
    // Same owner seen within a day: leave the entry alone, so a 5-minute
    // reconciler does not rewrite the whole document every tick.
    if (prev && prev.server === server && at.getTime() - Date.parse(prev.lastSeenAt) < REFRESH_MS) continue;
    next[key] = { server, lastSeenAt: at.toISOString() };
  }
  return next;
}

export async function rememberAddresses(
  db: Database,
  sightings: ReadonlyArray<{ readonly type: 'A' | 'AAAA'; readonly address: string; readonly server: string | null }>,
  at: Date = new Date(),
): Promise<AddressHistory> {
  const current = await readAddressHistory(db);
  const next = mergeAddressHistory(current, sightings, at);
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    const value = JSON.stringify(next);
    await db.insert(platformSettings).values({ key: ADDRESS_HISTORY_KEY, value })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
  }
  return next;
}
