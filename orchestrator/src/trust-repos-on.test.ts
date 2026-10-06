// Voir trust-repos.test.ts : ici les dépôts locaux sont permis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ATELIER_PASSWORD = "x";
process.env.ATELIER_ALLOW_LOCAL_REPOS = "1";
const home = mkdtempSync(join(tmpdir(), "atelier-home-"));
process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, "xdg"); process.env.GIT_CONFIG_NOSYSTEM = "1";
const list = () => execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

test("dépôts locaux permis : safe.directory * est écrit une seule fois, même après plusieurs démarrages", async () => {
  const { trustLocalRepos } = await import("./git.ts");
  trustLocalRepos(); trustLocalRepos();
  assert.deepEqual(list(), ["*"]);
});
