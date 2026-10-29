import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/src/app.ts';
import { loadConfig } from '../backend/src/config.ts';
import type { Principal } from '../shared/types.ts';
import WebSocket, { WebSocketServer } from 'ws';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'stage-runtime-'));
  const config=loadConfig({SESSION_KEY:'a'.repeat(64),TOKEN_ENCRYPTION_KEY:'b'.repeat(64),LOCAL_PREVIEW:'true',NODE_ENV:'test',DATA_DIR:dir,LIVEKIT_API_KEY:'runtime-key',LIVEKIT_API_SECRET:'c'.repeat(64)});
  return {dir,config};
}
const owner:Principal={userId:'preview-owner',displayName:'Test owner',deviceId:'test-device',isAdmin:true,isOwner:true};

test('duplicate application startup is refused before it can close an existing live session',async()=>{
  const {dir,config}=fixture();
  const first=await createApp(config,{disableFrontend:true,quiet:true});
  try{
    await first.service.execute(owner,{type:'session.open',mode:'stage',title:'Keep this session'});
    const id=first.service.snapshot(owner).session!.id;
    await assert.rejects(createApp(config,{disableFrontend:true,quiet:true}),/already using/);
    assert.equal(first.service.snapshot(owner).session!.id,id);
  }finally{await first.app.close();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown drains an authenticated event stream before closing the HTTP server',async()=>{
  const {dir,config}=fixture();
  const {app}=await createApp(config,{disableFrontend:true,quiet:true});
  const cookieJar:Record<string,string>={};
  const save=(response:{cookies:Array<{name:string;value:string}>})=>{for(const cookie of response.cookies)cookieJar[cookie.name]=cookie.value;};
  let closed=false;
  try{
    save(await app.inject({method:'GET',url:'/api/bootstrap'}));
    save(await app.inject({method:'POST',url:'/api/dev/login',headers:{origin:config.origin},cookies:cookieJar,payload:{persona:'owner'}}));
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();assert.ok(address&&typeof address!=='string');
    const stream=await fetch(`http://127.0.0.1:${address.port}/api/events`,{headers:{cookie:Object.entries(cookieJar).map(([name,value])=>`${name}=${encodeURIComponent(value)}`).join('; ')},signal:AbortSignal.timeout(8000)});
    assert.equal(stream.status,200);
    const reader=stream.body!.getReader();assert.equal((await reader.read()).done,false);
    await Promise.race([app.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Shutdown waited for the still-open event stream.')),2000).unref())]);closed=true;
    await reader.cancel();
  }finally{if(!closed)await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown drains an accepted frontend websocket upgrade before waiting for HTTP close',async()=>{
  const {dir,config}=fixture();
  const {app}=await createApp(config,{disableFrontend:true,quiet:true});
  const upgrades=new WebSocketServer({noServer:true});
  let client:WebSocket|undefined,accepted:WebSocket|undefined,closed=false;
  // This models a frontend HMR socket on the shared server, outside /rtc.
  app.server.on('upgrade',(request,socket,head)=>{
    if(request.url==='/_next/test-hmr')upgrades.handleUpgrade(request,socket,head,connection=>{
      accepted=connection;upgrades.emit('connection',connection,request);
    });
  });
  try{
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();assert.ok(address&&typeof address!=='string');
    client=new WebSocket(`ws://127.0.0.1:${address.port}/_next/test-hmr`);
    await once(client,'open');assert.ok(accepted);
    const disconnected=once(client,'close');
    await Promise.race([app.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Shutdown waited for the accepted frontend upgrade.')),2000).unref())]);closed=true;
    await Promise.race([disconnected,new Promise((_,reject)=>setTimeout(()=>reject(new Error('The frontend upgrade did not disconnect.')),2000).unref())]);
    assert.equal(client.readyState,WebSocket.CLOSED);
  }finally{
    client?.terminate();accepted?.terminate();
    await new Promise<void>(resolve=>upgrades.close(()=>resolve()));
    if(!closed)await app.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('concurrent recovery of a stale process lock permits only one startup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stage-lock-race-'));
  writeFileSync(join(dir,'app.lock'),JSON.stringify({pid:2147483647,token:'dead-process'}));
  const moduleURL=new URL('../backend/src/process-lock.ts',import.meta.url).href;
  const code=`import {existsSync} from 'node:fs';import{join}from'node:path';import{setTimeout as sleep}from'node:timers/promises';import{acquireProcessLock}from${JSON.stringify(moduleURL)};const dir=process.argv[1];console.log('ready');while(!existsSync(join(dir,'go')))await sleep(5);let release;try{release=acquireProcessLock(dir)}catch{console.log('blocked');process.exit(0)}console.log('locked');while(!existsSync(join(dir,'release')))await sleep(5);release();`;
  const children=Array.from({length:5},()=>spawn(process.execPath,['--import','tsx','--input-type=module','--eval',code,dir],{stdio:['ignore','pipe','pipe']}));
  let ready=0;const outcomes:string[]=[];
  const completion=children.map(child=>new Promise<void>((resolve,reject)=>{
    let pending='',errors='';
    child.stdout.on('data',chunk=>{
      pending+=String(chunk);let newline:number;
      while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline).trim();pending=pending.slice(newline+1);
        if(line==='ready'&&++ready===5)writeFileSync(join(dir,'go'),'go');
        if(line==='locked'||line==='blocked'){outcomes.push(line);if(outcomes.length===5)writeFileSync(join(dir,'release'),'release');}
      }
    });
    child.stderr.on('data',chunk=>errors+=String(chunk));
    child.once('error',reject);child.once('exit',status=>status===0?resolve():reject(new Error(errors||'Lock fixture failed.')));
  }));
  try{
    await Promise.race([Promise.all(completion),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Lock recovery fixture timed out.')),8000).unref())]);
    assert.equal(outcomes.filter(outcome=>outcome==='locked').length,1);assert.equal(outcomes.filter(outcome=>outcome==='blocked').length,4);
  }finally{
    for(const child of children)if(child.exitCode===null)child.kill();
    assert.ok(dir.startsWith(join(tmpdir(),'stage-lock-race-')));rmSync(dir,{recursive:true,force:true});
  }
});
