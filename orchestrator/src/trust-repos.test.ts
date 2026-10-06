// Dépôts locaux (démo/tests) : safe.directory est écrit dans la configuration GLOBALE (la seule que git honore pour cela), une seule fois,
// et seulement quand les dépôts locaux sont permis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ATELIER_PASSWORD = "x";
const home = mkdtempSync(join(tmpdir(), "atelier-home-"));
process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, "xdg"); process.env.GIT_CONFIG_NOSYSTEM = "1";
const list = () => { try { return execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

test("sans dépôts locaux permis : la configuration globale n'est pas touchée", async () => {
  delete process.env.ATELIER_ALLOW_LOCAL_REPOS;
  const { trustLocalRepos } = await import("./git.ts");
  trustLocalRepos();
  assert.deepEqual(list(), []);
});
