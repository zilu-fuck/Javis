import * as net from "node:net";

const blockedIpv4Networks = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Networks.addSubnet(network, prefix, "ipv4");
}

const blockedIpv6Networks = new net.BlockList();
for (const [network, prefix] of [
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  blockedIpv6Networks.addSubnet(network, prefix, "ipv6");
}

export function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) return blockedIpv4Networks.check(address, "ipv4");
  if (net.isIPv6(address)) return blockedIpv6Networks.check(address, "ipv6");
  return true;
}
