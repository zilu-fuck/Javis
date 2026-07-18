import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateIp } from "./network-policy.js";

test("allows public IPv4 addresses when IPv6 rules are also configured", () => {
  assert.equal(isPrivateIp("49.7.37.74"), false);
  assert.equal(isPrivateIp("104.21.17.214"), false);
});

test("blocks private and reserved IPv4 addresses", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("203.0.113.1"), true);
});

test("distinguishes public and reserved IPv6 addresses", () => {
  assert.equal(isPrivateIp("2400:89c0:1053:3::69"), false);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("2001:db8::1"), true);
});
