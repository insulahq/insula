import { networkInterfaces } from 'node:os';

/**
 * This machine's first non-loopback private IPv4, or null. A test server bound
 * to it stands for a catalog on the operator's own network: the SSRF guard
 * refuses loopback whatever the policy, so a local test server cannot use it.
 */
export function privateIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [o0, o1] = a.address.split('.').map(Number);
      const isPrivate = o0 === 10 || (o0 === 172 && o1! >= 16 && o1! <= 31) || (o0 === 192 && o1 === 168);
      // Not inside k3s's default pod/service networks, which the policy always refuses.
      if (isPrivate && !(o0 === 10 && (o1 === 42 || o1 === 43))) return a.address;
    }
  }
  return null;
}
