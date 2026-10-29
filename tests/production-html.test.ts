import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function verifyProductionHtml(mode: 'combined' | 'frontend') {
  const frontend = resolve('frontend');
  const built = JSON.parse(readFileSync(join(frontend, '.next/required-server-files.json'), 'utf8'));
  assert.equal(built.appDir, frontend, 'Production acceptance requires the frontend project build artifact.');
  const temp=mkdtempSync(join(tmpdir(),'stage-production-'));
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const address=probe.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
  const args = mode === 'combined' ? ['--import','tsx',resolve('backend/src/index.ts')]
    : [resolve('node_modules/next/dist/bin/next'), 'start', frontend, '--hostname', '127.0.0.1', '--port', String(port)];
  const child=spawn(process.execPath,args,{
    cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production',LOCAL_PREVIEW:'false',HOST:'127.0.0.1',PORT:String(port),APP_URL:`https://localhost:${port}`,FRONTEND_URL:'',DATA_DIR:temp,SESSION_KEY:'d'.repeat(64),TOKEN_ENCRYPTION_KEY:'e'.repeat(64),DISCORD_CLIENT_ID:'',DISCORD_CLIENT_SECRET:'',DISCORD_GUILD_ID:'',DISCORD_OWNER_ID:'',LIVEKIT_API_KEY:'production-test',LIVEKIT_API_SECRET:'f'.repeat(64)}
  });
  let output='';child.stdout.on('data',data=>output+=String(data));child.stderr.on('data',data=>output+=String(data));
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  try{
    let ready=false,lastProbe='';
    for(let attempt=0;attempt<80;attempt++){
      if(child.exitCode!==null)throw new Error('Production child exited: '+output);
      try{const response=await fetch(`http://127.0.0.1:${port}${mode==='combined'?'/healthz':'/'}`,{signal:AbortSignal.timeout(500)});if(response.ok){ready=true;break;}lastProbe=`HTTP ${response.status}`;}catch(error){lastProbe=error instanceof Error?error.message:String(error);}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,`Production server did not become ready (${lastProbe}):\n`+output);
    const read=async()=>{
      const response=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,200);
      const csp=response.headers.get('content-security-policy')??'';
      const nonce=csp.match(/'nonce-([^']+)'/)?.[1];assert.ok(nonce,'A request-specific CSP nonce is required.');
      const html=await response.text();
      const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      const inline=scripts.filter(match=>match[2].trim());assert.ok(inline.length>0,'Next hydration should emit inline bootstrap scripts.');
      for(const script of inline)assert.ok(script[1].includes(`nonce="${nonce}"`),'A hydration script is missing its CSP nonce.');
      assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp),false);
      return nonce;
    };
    assert.notEqual(await read(),await read(),'Nonces must differ across page responses.');
  }finally{
    if(child.exitCode===null)child.kill('SIGTERM');await exited;
    assert.ok(temp.startsWith(join(tmpdir(),'stage-production-')));rmSync(temp,{recursive:true,force:true});
  }
}

const productionCheck = { skip: process.env.RUN_PRODUCTION_CHECK !== '1' ? 'Set RUN_PRODUCTION_CHECK=1 after npm run build.' : false };
test('production combined app uses frontend CSP nonces on hydration scripts', productionCheck, () => verifyProductionHtml('combined'));
test('standalone production frontend protects hydration without the Fastify server', productionCheck, () => verifyProductionHtml('frontend'));
