import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root=process.cwd(),testPath='realtime/voice-v2/tests/adapters/speech-undici-stages.test.js';
const name='real pinned fetch/default per-synthesis Agent stages and request/audio match historical HEAD';
const output=resolve('evaluation/voice-v2-interpreter-corpus');mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(join(tmpdir(),'voice-v2-corpus-history-'));
const loader=join(scratch,'dependencies.mjs');
writeFileSync(loader,`const root=${JSON.stringify(pathToFileURL(join(root,'package.json')).href)};
export async function resolve(specifier,context,nextResolve){
  // Resolve snapshot package imports from the one authorized installation.
  // Deliberately leave data: parents untouched: the historical failure depends
  // on Node's native data-URL/bare-package resolution behavior.
  if(context.parentURL?.startsWith('file:')&&!specifier.startsWith('.')&&!specifier.startsWith('/')&&!specifier.includes(':'))
    return nextResolve(specifier,{...context,parentURL:root});
  return nextResolve(specifier,context);
}
`);
const rows=[];
for(const reference of ['cf8560b9ea9cea5515d3a9feac314ba78f02fac0','9eaab4ac','21ec066f939f8820478ce6997398ad9a6b554373']){
  const sha=execFileSync('git',['rev-parse',reference],{encoding:'utf8'}).trim();
  const snapshot=join(scratch,sha),archive=join(scratch,sha+'.zip');mkdirSync(snapshot);
  execFileSync('git',['archive','--format=zip',`--output=${archive}`,sha]);
  execFileSync('tar.exe',['-xf',archive,'-C',snapshot]);
  const committed=execFileSync('git',['show',`${sha}:${testPath}`],{encoding:'utf8'});
  if(!committed.includes(name))throw Error('REQUIRED_HISTORICAL_TEST_ABSENT');
  if(readFileSync(join(snapshot,testPath),'utf8').replace(/\r\n/g,'\n')!==committed.replace(/\r\n/g,'\n'))throw Error('SNAPSHOT_TEST_DIFFERS');
  const command=[process.execPath,'--experimental-loader',pathToFileURL(loader).href,'--test',`--test-name-pattern=${name}`,join(snapshot,testPath)];
  const run=spawnSync(command[0],command.slice(1),{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024,env:{...process.env,NODE_OPTIONS:''}});
  if(run.error)throw run.error;
  const text=(run.stdout||'')+'\n'+(run.stderr||'');
  const code=text.match(/(?:code: |Error \[)['"]?(ERR_[A-Z_]+)/)?.[1]||null;
  const frameLines=text.split(/\r?\n/).filter(line=>/^\s+(?:packageResolve|moduleResolve|defaultResolve|ModuleLoader\.|new URL|at )/.test(line))
    .map(line=>line.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'<historical-data-module>').replaceAll(snapshot,'<snapshot>')).slice(0,8);
  const result={reference,sha,testName:name,command,node:process.version,npm:execFileSync('npm.cmd',['--version'],{encoding:'utf8',shell:true}).trim(),
    undici:JSON.parse(readFileSync(createRequire(pathToFileURL(join(root,'package.json'))).resolve('undici/package.json'),'utf8')).version,
    exitCode:run.status,errorCode:code,passed:/# pass 1\b/.test(text),failed:/# fail 1\b/.test(text),
    nativeCommittedTest:true,activeFilesReplaced:false,stack:frameLines,
    loopbackServerStarted:false,loopbackEvidence:'The data-URL baseline import throws before createServer()/listen() in the selected test.',
    unsupportedResolutionDetected:text.includes('ERR_UNSUPPORTED_RESOLVE_REQUEST'),dependencyBoundary:'file: snapshot imports use authorized root dependencies; data: imports retain native Node resolution'};
  if(run.status!==1||!result.failed||!result.unsupportedResolutionDetected)throw Error('HISTORICAL_FAILURE_CHANGED_REVIEW_REQUIRED');
  rows.push(result);console.log(JSON.stringify({sha,exitCode:run.status,errorCode:code}));
}
const introduction=execFileSync('git',['log','--all','--format=%H %s','-S',name,'--',testPath],{encoding:'utf8'}).trim();
writeFileSync(join(output,'historical-undici.json'),JSON.stringify({testName:name,introduction,rows,scratch,
  conclusion:'All three committed versions fail under this Node/dependency environment before loopback begins. The immediate cause is the test importing a historical adapter via data: while retaining a bare undici import. This is an environment-sensitive test/module-loading defect, not evidence of a provider or production transport failure. Git proves the test was introduced at 9eaab4ac; historical CI/runtime onset is not established.'},null,2)+'\n');
