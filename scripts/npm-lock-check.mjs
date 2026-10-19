// Only the disposable smoke stack: exercise the real restricted npm installer, without model credentials.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile);
const script=`
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {db} from './src/db.ts';
import {cfg} from './src/config.ts';
import {issueTaskToken,revokeTaskTokens} from './src/tokens.ts';
import {installDependencies} from './src/sandbox.ts';
import {createProxy} from './src/proxy.ts';
const proxy=createProxy().listen(18085);
const org=db.prepare('select id from orgs limit 1').get().id;
const job='npm-lock-check',tree=join(cfg.workDir,'_npm-lock-check'),token=issueTaskToken(job,org);
try {
  await mkdir(tree,{recursive:true});
  const manifest={name:'atelier-lock-check',version:'1.0.0',private:true,scripts:{postinstall:'node -e "require(\\'node:fs\\').writeFileSync(\\'INSTALL_SCRIPT_RAN\\',\\'bad\\')"'}};
  await writeFile(join(tree,'package.json'),JSON.stringify(manifest));
  execFileSync('chown',['-R','1000:1000',tree]);
  await installDependencies('atelier-lock-initial',tree,token);
  manifest.dependencies={'is-number':'7.0.0'};
  await writeFile(join(tree,'package.json'),JSON.stringify(manifest));
  await installDependencies('atelier-lock-update',tree,token);
  const lock=JSON.parse(await readFile(join(tree,'package-lock.json'),'utf8'));
  assert.equal(lock.packages[''].dependencies['is-number'],'7.0.0');
  assert.equal(JSON.parse(await readFile(join(tree,'node_modules/is-number/package.json'),'utf8')).version,'7.0.0');
  await assert.rejects(access(join(tree,'INSTALL_SCRIPT_RAN')));
  assert.ok(!JSON.stringify(lock).includes('8081/npm'));
  console.log('NPM LOCK UPDATE AND DISABLED INSTALL SCRIPTS OK');
}finally{revokeTaskTokens(job);proxy.closeAllConnections();proxy.close();await rm(tree,{recursive:true,force:true});}
`;
try {
  const result=await run("docker",["exec","-e","PROXY_URL=http://atelier-smoke-orchestrator:18085","atelier-smoke-orchestrator","node","--input-type=module","-e",script],{timeout:300000,maxBuffer:2e6});
  process.stdout.write(result.stdout);
}catch(error){process.stderr.write(error.stderr||error.message);process.exitCode=1;}
