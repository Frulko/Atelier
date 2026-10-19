// Only dependency installation has network access, through the token-authenticated npm proxy.
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
if (!existsSync("/work/package.json")) process.exit(0);
const registry = new URL(process.env.ATELIER_NPM_REGISTRY);
writeFileSync(
  "/tmp/atelier-npmrc",
  `registry=${registry.href}\n//${registry.host}${registry.pathname}:_authToken=${process.env.ATELIER_NPM_TOKEN}\nalways-auth=true\nignore-scripts=true\naudit=false\nfund=false\n`,
  { mode: 0o600 },
);
const lock = existsSync("/work/package-lock.json")
  ? readFileSync("/work/package-lock.json", "utf8")
  : null;
if (lock)
  writeFileSync(
    "/work/package-lock.json",
    lock.replaceAll("https://registry.npmjs.org/", registry.href),
  );
const result = spawnSync(
  "npm",
  [
    existsSync("/work/package-lock.json") ? "ci" : "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ],
  {
    cwd: "/work",
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp",
      npm_config_userconfig: "/tmp/atelier-npmrc",
      npm_config_cache: "/tmp/npm-cache",
    },
    stdio: "inherit",
    timeout: 240000,
  },
);
if (existsSync("/work/package-lock.json")) {
  const value = readFileSync("/work/package-lock.json", "utf8").replaceAll(
    registry.href,
    "https://registry.npmjs.org/",
  );
  writeFileSync(
    "/work/package-lock.json",
    lock && result.status !== 0 ? lock : value,
  );
}
process.exit(result.status ?? 1);
