import { networkInterfaces } from 'node:os';

export interface LocalAddress { name: string; address: string }

/** Offer private IPv4 interfaces, preferring LAN adapters over virtual bridges. */
export function localAddresses(interfaces = networkInterfaces()): LocalAddress[] {
  const addresses: LocalAddress[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || seen.has(entry.address)) continue;
      const parts = entry.address.split('.').map(Number);
      if (parts.length !== 4 || !parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) continue;
      const [a, b] = parts;
      if (!(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254)) continue;
      seen.add(entry.address); addresses.push({ name, address: entry.address });
    }
  }
  const virtual = /^(docker|veth|br-|virbr|vmnet|vboxnet|tailscale|utun|tun\d|tap\d|wg\d|zt|lo\b|cni|podman|lxc)/i;
  const lan = addresses.filter(item => !virtual.test(item.name));
  return (lan.length ? lan : addresses).sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}
