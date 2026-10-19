import { test } from "node:test";
import assert from "node:assert/strict";
process.env.ATELIER_PASSWORD = "test";
process.env.DB_FILE = ":memory:";
const { addressAllowed } = await import("./health.ts");
const { repositoryAddresses, applicationCsp } = await import("./security.ts");
const { cookieHeader, tokenFromCookie } = await import("./session.ts");
test("network guard: metadata including IPv4-mapped IPv6 and multicast always denied", () => {
  for (const ip of [
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "0.0.0.0",
    "fe80::1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(addressAllowed(ip, false), false, ip);
    assert.equal(addressAllowed(ip, true), false, ip);
  }
  for (const ip of [
    "127.0.0.1",
    "::ffff:7f00:1",
    "10.0.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
  ])
    assert.equal(addressAllowed(ip, false), false, ip);
});
test("git: credentials, non-HTTPS and private literal addresses rejected before connecting", async () => {
  for (const url of [
    "https://127.0.0.1/repo",
    "https://[::ffff:a9fe:a9fe]/repo",
    "http://github.com/repo",
    "https://token@github.com/repo",
  ])
    await assert.rejects(repositoryAddresses(url));
});
test("application CSP blocks external fetches, forms, frames and reporting sinks", () => {
  const csp = applicationCsp("https://atelier.example.com");
  for (const rule of [
    "default-src 'none'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors https://atelier.example.com",
  ])
    assert.ok(csp.includes(rule));
  assert.ok(!csp.includes("https:" + " "));
  assert.ok(!csp.includes("report-uri"));
});
test("HTTPS session cookies cannot be injected by another subdomain", () => {
  assert.ok(
    cookieHeader("secret", true).startsWith("__Host-atelier_session=secret;"),
  );
  assert.equal(
    tokenFromCookie(
      "atelier_session=attacker; __Host-atelier_session=real",
      true,
    ),
    "real",
  );
  assert.equal(tokenFromCookie("atelier_session=attacker", true), undefined);
});

test("secret scanner: known values, private keys, sensitive paths and escaped symlinks rejected", async () => {
  const { containsSecret, sensitivePath, assertSafeFiles } =
    await import("./security.ts");
  const { mkdtemp, writeFile, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.ok(
    containsSecret("value = confidential-value", ["confidential-value"]),
  );
  assert.ok(containsSecret("-----BEGIN PRIVATE KEY-----\nkey"));
  assert.ok(containsSecret("atl_"+"a".repeat(32)));
  assert.ok(containsSecret("123456:"+"a".repeat(35)));
  assert.ok(sensitivePath("config/.env.production"));
  assert.equal(sensitivePath(".env.example"), false);
  const dir = await mkdtemp(join(tmpdir(), "atelier-scan-"));
  try {
    await writeFile(join(dir, "safe.txt"), "ordinary content");
    await assertSafeFiles(dir, ["safe.txt"]);
    await writeFile(join(dir, ".env"), "SECRET=x");
    await assert.rejects(assertSafeFiles(dir, [".env"]), /sensible/);
    await symlink("/etc/passwd", join(dir, "escape"));
    await assert.rejects(assertSafeFiles(dir, ["escape"]), /symbolique/);
    await writeFile(join(dir, "key.txt"), "-----BEGIN PRIVATE KEY-----");
    await assert.rejects(assertSafeFiles(dir, ["key.txt"]), /secret potentiel/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command logs mask secrets before truncation and remove terminal controls", async () => {
  const { safeLogText, taskLogRedactor } = await import("./security.ts");
  const { createUser, createOrg } = await import("./db.ts");
  const { storeSecret } = await import("./vault.ts");
  const org = createOrg("Command logs", createUser("command-logs@example.test", "hash").id);
  const secret = "private-command-value";
  storeSecret(org, "git_token", null, "Git", secret);
  const redact = await taskLogRedactor(org);
  assert.match(redact(`command output: ${secret}`), /masqué/);
  assert.match(redact("x".repeat(40000) + secret), /masqué/);
  assert.equal(redact("\u001b[31mhello\u001b[0m\u0007"), "hello");
  assert.match(safeLogText("token=atl_" + "a".repeat(32)), /masqué/);
  assert.match(redact("x".repeat(33000)), /tronquée/);
});
