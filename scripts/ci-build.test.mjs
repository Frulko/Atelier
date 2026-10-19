import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const sha = "a".repeat(40);
for (const [branch, tag, alias] of [["main", "", "latest"], ["staging", "", "staging"], ["", "v1.2.3", "1.2.3"]]) {
  test(`BuildKit : ${branch || tag} conserve le commit et publie l'alias ${alias}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-ci-build-"));
    try {
      const mock = join(dir, "buildctl.mjs"), output = join(dir, "args.json");
      writeFileSync(mock, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2)));');
      const env = {
        ...process.env,
        BUILDCTL: `${process.execPath} ${mock} --addr tcp://builder:1234`,
        OUTPUT: output,
        IMAGE: "registry.example.com/team/atelier/atelier",
        ATELIER_RELEASE: `commit-${sha}`,
        CI_COMMIT_BRANCH: branch, CI_COMMIT_TAG: tag, CI_DEFAULT_BRANCH: "main",
        CI_PROJECT_URL: "https://gitlab.example.com/team/atelier",
        BUILD_CONTEXT: ".", DOCKERFILE_DIR: "orchestrator", PLATFORMS: "linux/amd64",
      };
      const result = spawnSync("sh", [new URL("../.gitlab/ci/build.sh", import.meta.url).pathname], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const args = JSON.parse(readFileSync(output, "utf8"));
      assert.deepEqual(args.slice(0, 3), ["--addr", "tcp://builder:1234", "build"]);
      assert.ok(args.includes("context=."));
      assert.ok(args.includes("dockerfile=orchestrator"));
      assert.ok(args.includes("platform=linux/amd64"));
      assert.ok(args.includes(`build-arg:ATELIER_VERSION=${tag ? "1.2.3" : `commit-${sha}`}`));
      assert.equal(args.at(-1), `type=image,"name=${env.IMAGE}:commit-${sha},${env.IMAGE}:${alias}",push=true`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
