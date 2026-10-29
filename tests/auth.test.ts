import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Command, Principal } from '../shared/types.ts';
import { AuthService, AuthError, type DiscordQuotaDiagnostic } from '../backend/src/auth/auth-service.ts';
import { loadConfig } from '../backend/src/config.ts';
import { createApp, recheckMemberships } from '../backend/src/app.ts';

function fixture(options:{memberStatus?:number;roles?:string[];preview?:boolean}={}) {
  const dir=mkdtempSync(join(tmpdir(),'stage-auth-'));
  let now=Date.now(),status=options.memberStatus??200,roles=options.roles??['role-admin'];
  const calls:string[]=[];
  const databasePath=join(dir,'auth.sqlite');
  const auth=new AuthService({databasePath,encryptionKey:'b'.repeat(64),guildId:'guild',clientId:'client',clientSecret:'secret',preview:options.preview??false,cacheSeconds:30,maxStaleSeconds:300,
    adminConfiguration:()=>({ownerUserId:'999999999999999999',adminRoleIds:['role-admin'],explicitAdminUserIds:[]}),now:()=>now,
    fetch:async(input)=>{
      const url=String(input);calls.push(url);
      if(url.endsWith('/users/@me'))return Response.json({id:'111111111111111111',username:'Verified user'});
      if(url.endsWith('/member'))return status===200?Response.json({roles}):Response.json({error:'test'},{status,headers:status===429?{'retry-after':'30'}:{}});
      return Response.json({access_token:'renewed-access',refresh_token:'renewed-refresh',expires_in:3600});
    }
  });
  return {auth,calls,databasePath,advance:(ms:number)=>{now+=ms;},setStatus:(n:number)=>{status=n;},setRoles:(next:string[])=>{roles=next;},cleanup:()=>{auth.close();rmSync(dir,{recursive:true,force:true});}};
}
const tokens={access_token:'test-only-access-token',refresh_token:'test-only-refresh-token',expires_in:3600};

test('membership cache cannot exceed the maximum verification age', () => {
  const settings = { SESSION_KEY: 'a'.repeat(64), TOKEN_ENCRYPTION_KEY: 'b'.repeat(64), MEMBERSHIP_CACHE_SECONDS: '60', MEMBERSHIP_MAX_STALE_SECONDS: '30' };
  assert.throws(() => loadConfig(settings), /membership cache/i);
  assert.equal(loadConfig({ ...settings, MEMBERSHIP_MAX_STALE_SECONDS: '300' }).MEMBERSHIP_CACHE_SECONDS, 60);
});

test('one strict membership network request serves all verification modes while stale fallback remains caller-specific',async()=>{
  const id='111111111111111111';let now=Date.now(),calls=0,fail=false;
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:60,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),fetch:async input=>{
      if(String(input).endsWith('/users/@me'))return Response.json({id,username:'Fixture'});
      calls++;if(fail){await new Promise(resolve=>setTimeout(resolve,10));return Response.json({retry_after:90},{status:429});}return Response.json({roles:[]});
    }});
  try{
    const sid=await auth.completeDiscord(tokens,'device');now+=61000;calls=0;fail=true;
    const results=await Promise.allSettled([auth.principal(sid,'device',{fresh:true,allowStale:false}),auth.principal(sid,'device',{fresh:true,allowStale:true}),auth.principal(sid,'device',{allowStale:true})]);
    assert.equal(calls,1,'A single account must not spend separate provider requests for strict, fresh, and relaxed callers.');
    assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(results[2].status,'fulfilled');
  }finally{auth.close();}
});

test('successful quota exhaustion reserves the complete reset deadline and OAuth relogin cannot reset it',async()=>{
  const id='111111111111111111';let now=Date.now(),memberCalls=0;
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:60,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),fetch:async input=>{
      if(String(input).endsWith('/users/@me'))return Response.json({id,username:'Fixture'});
      memberCalls++;return Response.json({roles:[]},{headers:memberCalls===1?{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'180'}:{}});
    }});
  try{
    const sid=await auth.completeDiscord(tokens,'device');assert.equal((await auth.principal(sid,'device')).userId,id);now+=61000;
    await assert.rejects(auth.principal(sid,'device',{fresh:true}),error=>error instanceof AuthError&&error.status===503&&'retryAfterSeconds' in error&&error.retryAfterSeconds===119);
    await assert.rejects(auth.completeDiscord({...tokens,access_token:'new-test-token'},'device-two'),AuthError);
    assert.equal(memberCalls,1,'Successful remaining=0 must prevent retries and re-login amplification until reset.');
    assert.equal((await auth.principal(sid,'device',{allowStale:true})).userId,id);
    now+=119000;assert.equal((await auth.principal(sid,'device',{fresh:true})).userId,id);assert.equal(memberCalls,2);
  }finally{auth.close();}
});

test('global provider cooldown survives a service restart and blocks other accounts without accepting stale strict proof',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stage-global-quota-'));
  const ids=['111111111111111111','222222222222222222'];let now=Date.now(),globalLimit=false,memberCalls=0,identityCalls=0;
  const options={databasePath:join(dir,'auth.sqlite'),encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:60,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:ids[0],adminRoleIds:[],explicitAdminUserIds:[]}),fetch:async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
      if(String(input).endsWith('/users/@me')){identityCalls++;return Response.json({id:new Headers(init?.headers).get('authorization')==='Bearer account-b'?ids[1]:ids[0],username:'Fixture'});}
      memberCalls++;return globalLimit?Response.json({retry_after:120,global:true},{status:429,headers:{'x-ratelimit-scope':'global'}}):Response.json({roles:[]});
    }};
  let auth=new AuthService(options);
  try{
    const a=await auth.completeDiscord(tokens,'device-a'),b=await auth.completeDiscord({...tokens,access_token:'account-b'},'device-b');
    now+=61000;globalLimit=true;
    await assert.rejects(auth.principal(a,'device-a',{fresh:true}),error=>error instanceof AuthError&&error.retryAfterSeconds===120);
    auth.close();auth=new AuthService(options);
    await assert.rejects(auth.principal(b,'device-b',{fresh:true}),error=>error instanceof AuthError&&error.retryAfterSeconds===120);
    await assert.rejects(auth.completeDiscord({...tokens,access_token:'account-b'},'device-c'),AuthError);
    assert.equal(memberCalls,3);assert.equal(identityCalls,2,'A known global deadline must stop even OAuth identity network attempts.');
    assert.equal((await auth.principal(b,'device-b',{allowStale:true})).userId,ids[1]);
    globalLimit=false;now+=120000;
    assert.equal((await auth.principal(b,'device-b',{fresh:true})).userId,ids[1]);assert.equal(memberCalls,4);
  }finally{auth.close();rmSync(dir,{recursive:true,force:true});}
});

test('token-refresh 429 persists its full cooldown and a new OAuth grant cannot erase it',async()=>{
  const id='111111111111111111';let now=Date.now(),refreshCalls=0,memberCalls=0;
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:60,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),fetch:async input=>{
      if(String(input).endsWith('/users/@me'))return Response.json({id,username:'Fixture'});
      if(String(input).endsWith('/member')){memberCalls++;return Response.json({roles:[]});}
      refreshCalls++;return Response.json({retry_after:74.5},{status:429,headers:{'retry-after':'72'}});
    }});
  try{
    const sid=await auth.completeDiscord({...tokens,expires_in:90},'device');now+=31000;
    await assert.rejects(auth.principal(sid,'device',{fresh:true}),error=>error instanceof AuthError&&error.retryAfterSeconds===75);
    now+=30000;
    await assert.rejects(auth.principal(sid,'device',{fresh:true}),error=>error instanceof AuthError&&error.retryAfterSeconds===45);
    await assert.rejects(auth.completeDiscord({...tokens,access_token:'new-grant'},'device-two'),AuthError);
    assert.equal(refreshCalls,1);assert.equal(memberCalls,1);
    now+=44500;
    assert.equal((await auth.principal(sid,'device',{fresh:true})).userId,id);assert.equal(memberCalls,2);assert.equal(refreshCalls,1);
  }finally{auth.close();}
});

test('Discord quota diagnostics capture successful limits and 429 body/header cooldown using only allowlisted non-sensitive fields',async()=>{
  const diagnostics:DiscordQuotaDiagnostic[]=[];
  let limited=false;
  const id='111111111111111111';
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'private-guild-marker',clientId:'private-client-marker',clientSecret:'private-secret-marker',preview:false,cacheSeconds:30,maxStaleSeconds:300,
    adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),onDiscordQuota:diagnostic=>diagnostics.push(diagnostic),fetch:async input=>{
      if(String(input).endsWith('/users/@me'))return Response.json({id,username:'private-name-marker'});
      return limited?Response.json({retry_after:245.5,global:false,access_token:'private-access-marker',guild_id:'private-guild-marker',message:'private-body-marker'},{status:429,headers:{'x-ratelimit-limit':'5','x-ratelimit-remaining':'0','x-ratelimit-reset-after':'244.75','retry-after':'240','x-ratelimit-scope':'user','authorization':'private-header-marker','x-ratelimit-bucket':'private-bucket-marker'}})
        :Response.json({roles:[]},{headers:{'x-ratelimit-limit':'5','x-ratelimit-remaining':'4','x-ratelimit-reset-after':'239.75','x-ratelimit-scope':'user','set-cookie':'private-cookie-marker'}});
    }});
  try{
    await auth.completeDiscord(tokens,'private-device-marker');
    assert.deepEqual(diagnostics,[{endpoint:'membership',status:200,limit:5,remaining:4,resetAfter:239.75,scope:'user'}],'Identity without quota headers must not generate noise.');
    limited=true;
    await assert.rejects(auth.verify(id,true,false),error=>error instanceof AuthError&&error.status===503);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(diagnostics[1],{endpoint:'membership',status:429,limit:5,remaining:0,resetAfter:244.75,retryAfter:245.5,scope:'user',global:false});
    const serialized=JSON.stringify(diagnostics);
    assert.equal(serialized.includes('private-'),false,'No body, header, cookie, endpoint identity, account identity, or token value may enter diagnostics.');
    assert.equal(serialized.includes(id),false);
    assert.equal(diagnostics.length,2);
  }finally{auth.close();}
});

test('Discord quota diagnostics reject malformed header values and cannot break authorization when the observer throws',async()=>{
  const diagnostics:DiscordQuotaDiagnostic[]=[];
  const id='111111111111111111';
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:30,maxStaleSeconds:300,
    adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),onDiscordQuota:diagnostic=>{diagnostics.push(diagnostic);throw new Error('Isolated log failure.');},fetch:async input=>{
      if(String(input).endsWith('/users/@me'))return Response.json({id,username:'Fixture'});
      return Response.json({roles:[]},{headers:{'x-ratelimit-limit':'private-marker','x-ratelimit-remaining':'-1','x-ratelimit-reset-after':'Infinity','retry-after':'NaN','x-ratelimit-scope':'private-marker','x-ratelimit-global':'private-marker'}});
    }});
  try{
    const sid=await auth.completeDiscord(tokens,'fixture-device');
    assert.equal((await auth.principal(sid,'fixture-device')).userId,id);
    assert.deepEqual(diagnostics,[{endpoint:'membership',status:200}]);
  }finally{auth.close();}
});

test('token-refresh quota diagnostics expose only the endpoint category and numeric/global quota data',async()=>{
  const diagnostics:DiscordQuotaDiagnostic[]=[];
  const id='111111111111111111';
  let now=Date.now(),limited=false;
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'private-guild-marker',clientId:'private-client-marker',clientSecret:'private-secret-marker',preview:false,cacheSeconds:30,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),onDiscordQuota:diagnostic=>diagnostics.push(diagnostic),fetch:async input=>{
      const url=String(input);
      if(url.endsWith('/users/@me'))return Response.json({id,username:'Fixture'});
      if(url.endsWith('/member'))return Response.json({roles:[]});
      return limited?Response.json({retry_after:65.25,global:true,refresh_token:'private-refreshed-marker',error:'private-error-marker'},{status:429,headers:{'x-ratelimit-scope':'global','x-ratelimit-global':'true'}})
        :Response.json({access_token:'private-access-marker',refresh_token:'private-refresh-marker',expires_in:3600},{headers:{'x-ratelimit-limit':'10','x-ratelimit-remaining':'9','x-ratelimit-reset-after':'60'}});
    }});
  try{
    await auth.completeDiscord({...tokens,expires_in:0},'fixture-device');
    assert.deepEqual(diagnostics,[{endpoint:'token_refresh',status:200,limit:10,remaining:9,resetAfter:60}]);
    limited=true;now+=3600001;
    await assert.rejects(auth.verify(id,true,false),error=>error instanceof AuthError&&error.status===503);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(diagnostics[1],{endpoint:'token_refresh',status:429,retryAfter:65.25,scope:'global',global:true});
    assert.equal(JSON.stringify(diagnostics).includes('private-'),false);
  }finally{auth.close();}
});

async function admittedApiFixture() {
  const dir=mkdtempSync(join(tmpdir(),'stage-publishing-auth-'));
  const owner:Principal={userId:'111111111111111111',displayName:'Fixture owner',deviceId:'fixture-device',isOwner:true,isAdmin:true};
  let calls=0,limited=false;
  const config=loadConfig({SESSION_KEY:'a'.repeat(64),TOKEN_ENCRYPTION_KEY:'b'.repeat(64),LOCAL_PREVIEW:'false',NODE_ENV:'test',DATA_DIR:dir,MEMBERSHIP_CACHE_SECONDS:'30',DISCORD_CLIENT_ID:'222222222222222222',DISCORD_CLIENT_SECRET:'fixture-only',DISCORD_GUILD_ID:'333333333333333333',DISCORD_OWNER_ID:owner.userId,LIVEKIT_API_KEY:'fixture-key',LIVEKIT_API_SECRET:'c'.repeat(64)});
  const bundle=await createApp(config,{disableFrontend:true,quiet:true,fetch:async input=>{
    if(String(input).endsWith('/users/@me'))return Response.json({id:owner.userId,username:owner.displayName});
    if(String(input).endsWith('/member')){calls++;return limited?Response.json({retry_after:60},{status:429,headers:{'retry-after':'60'}}):Response.json({roles:[]});}
    throw new Error('Unexpected fixture provider request.');
  }});
  // Mock SFU effects only; HTTP authentication, admission, policy, and credentials use real app code.
  bundle.media.reconcile=async()=>undefined;
  bundle.media.remove=async()=>undefined;
  bundle.media.closeRoom=async()=>undefined;
  bundle.media.ensureRoom=async()=>undefined;
  bundle.media.hasScreen=async()=>false;
  const sid=await bundle.auth.completeDiscord(tokens,owner.deviceId);
  const cookie=(sessionId=sid,deviceId=owner.deviceId)=>({stage_session:bundle.app.encodeSecureSession(bundle.app.createSecureSession({sid:sessionId,deviceId}))});
  const command=(payload:Command)=>bundle.app.inject({method:'POST',url:'/api/commands',headers:{origin:config.origin},cookies:cookie(),payload});
  const mediaToken=(cookies=cookie())=>bundle.app.inject({method:'POST',url:'/api/media/token',headers:{origin:config.origin},cookies,payload:{}});
  // A different admin opens the room; the authenticated owner under test still
  // has neither an admission nor stage permission until their explicit commands.
  const openingAdmin={...owner,userId:'fixture-opening-admin',deviceId:'fixture-opening-device',isOwner:false,isAdmin:true};
  await bundle.service.execute(openingAdmin,{type:'session.open',mode:'stage',title:'Fixture media policy'});
  await bundle.service.execute(openingAdmin,{type:'session.start'});
  return {...bundle,owner,cookie,command,mediaToken,calls:()=>calls,resetCalls:()=>{calls=0;},limit:()=>{limited=true;},
    age:(milliseconds:number,retry=false)=>{const db=new DatabaseSync(join(dir,'auth.sqlite'));try{db.prepare('UPDATE auth_accounts SET verified_at=?,retry_at=? WHERE id=?').run(Date.now()-milliseconds,retry?Date.now()+60000:0,owner.userId);}finally{db.close();}},
    cleanup:async()=>{await bundle.app.close();rmSync(dir,{recursive:true,force:true});}};
}

test('room admission and token issuance reuse a current successful membership proof and reject stale or missing admission',async()=>{
  const f=await admittedApiFixture();
  try{
    assert.equal((await f.mediaToken()).statusCode,403,'A session cookie alone must not issue media credentials.');
    f.resetCalls();
    assert.equal((await f.command({type:'room.join'})).statusCode,200);
    assert.equal(f.calls(),0,'A new device admission may reuse its current successful proof; it must not force a provider request per button.');
    const token=await f.mediaToken();assert.equal(token.statusCode,200);assert.equal(typeof token.json().token,'string');
    assert.equal(f.calls(),0,'The immediate token request must reuse the same successful proof.');
    assert.equal((await f.mediaToken(f.cookie(undefined,'another-device'))).statusCode,401);
    const other=await f.auth.completeDiscord(tokens,'other-valid-device');
    assert.equal((await f.mediaToken(f.cookie(other,'other-valid-device'))).statusCode,403);
    f.age(31000);f.limit();f.resetCalls();
    assert.equal((await f.mediaToken()).statusCode,503,'Expired ordinary cache cannot become stale permission to issue a token.');
    assert.equal(f.calls(),1);
    assert.equal((await f.mediaToken()).statusCode,503);assert.equal(f.calls(),1,'Provider cooldown prevents another network attempt.');
    f.age(0);
    assert.equal((await f.command({type:'room.leave'})).statusCode,200);
    assert.equal((await f.mediaToken()).statusCode,403,'A revoked admission cannot issue media credentials.');
  }finally{await f.cleanup();}
});

test('HTTP waiting-room open returns the host admission while shared speaking controls and Go live require current membership proof',async()=>{
  const f=await admittedApiFixture();
  try{
    assert.equal((await f.command({type:'session.end'})).statusCode,200);
    const response=await f.command({type:'session.open',mode:'stage',title:'HTTP waiting room'});
    assert.equal(response.statusCode,200);
    const opened=response.json();
    assert.equal(opened.snapshot.session.state,'waiting');
    assert.equal(opened.snapshot.self.admission.id,opened.admission.id);
    assert.equal(opened.admission.deviceId,f.owner.deviceId);
    assert.equal(opened.snapshot.self.canShare,true);
    assert.equal(opened.snapshot.self.microphoneOwned,false);
    f.resetCalls();
    assert.equal((await f.command({type:'room.mode',mode:'open'})).statusCode,200);
    assert.equal(f.calls(),0,'Waiting controls reuse recent successful proof instead of amplifying provider traffic.');
    f.age(31000);f.limit();
    assert.equal((await f.command({type:'room.mode',mode:'stage'})).statusCode,503);
    assert.equal((await f.command({type:'session.start'})).statusCode,503);
    assert.equal(f.service.snapshot(f.owner).session?.state,'waiting');
    assert.equal(f.service.snapshot(f.owner).session?.waitingAudienceCanSpeak,true,'Failed fresh verification cannot mutate waiting audio.');
    f.age(0);
    assert.equal((await f.command({type:'session.start'})).statusCode,200);
    assert.equal(f.service.snapshot(f.owner).session?.state,'live');
    assert.equal(f.service.snapshot(f.owner).session?.waitingAudienceCanSpeak,true);
    assert.equal(f.service.snapshot(f.owner).session?.mode,'open');
  }finally{await f.cleanup();}
});

test('recent-proof admin actions and admitted self-publishing preserve stage, microphone, confirmation, and quota enforcement',async()=>{
  const f=await admittedApiFixture();
  try{
    assert.equal((await f.command({type:'room.join'})).statusCode,200);
    f.limit();f.resetCalls();
    assert.equal((await f.command({type:'room.lock',locked:false})).statusCode,200);
    f.media.health=async()=>true;
    assert.equal((await f.app.inject({method:'GET',url:'/api/admin/health',cookies:f.cookie()})).statusCode,200);
    assert.equal((await f.auth.principalForAccount(f.owner.userId)).isOwner,true);
    assert.equal(f.calls(),0);
    const audience=await f.command({type:'share.reserve'});
    assert.equal(audience.statusCode,403);assert.equal(audience.json().error,'stage_required');
    assert.equal((await f.command({type:'member.stage',userId:f.owner.userId,onStage:true})).statusCode,200,'Admin actions reuse a successful bounded proof, without stale fallback.');
    assert.equal((await f.command({type:'mic.acquire'})).statusCode,200);
    await f.service.execute(f.owner,{type:'member.microphone',userId:f.owner.userId,action:'block'});
    const blocked=await f.command({type:'mic.acquire'});assert.equal(blocked.statusCode,403);assert.equal(blocked.json().error,'microphone_blocked');
    const share=await f.command({type:'share.reserve'});assert.equal(share.statusCode,200);
    const reservationId=share.json().reservation.reservationId;
    assert.equal((await f.command({type:'share.confirm',reservationId})).statusCode,409,'SFU publication confirmation remains mandatory.');
    f.media.hasScreen=async()=>true;
    assert.equal((await f.command({type:'share.confirm',reservationId})).statusCode,200);
    await f.command({type:'share.release'});
    for(let index=0;index<3;index++){
      const actor={...f.owner,userId:`fixture-speaker-${index}`,deviceId:`speaker-device-${index}`,isOwner:false,isAdmin:false};
      await f.service.admit(actor);
      await f.service.execute(f.owner,{type:'member.stage',userId:actor.userId,onStage:true});
      await f.service.execute(actor,{type:'share.reserve'});
    }
    const full=await f.command({type:'share.reserve'});assert.equal(full.statusCode,409);assert.equal(full.json().error,'screen_slots_full');
    assert.equal(f.calls(),0,'Recent successful proof must serve the entire action burst.');
    f.age(31000);
    const expiredProof=await f.command({type:'room.lock',locked:false});
    assert.equal(expiredProof.statusCode,503,'An expired proof cannot authorize a sensitive action through stale fallback.');
    assert.equal(expiredProof.json().retryAfterSeconds,60);
    assert.equal(expiredProof.headers['retry-after'],'60');
    assert.equal(f.calls(),1);
    f.age(301000,true);
    assert.equal((await f.command({type:'share.reserve'})).statusCode,503,'Existing-participant grace still expires after 300 seconds.');
    const boot=await f.app.inject({method:'GET',url:'/api/bootstrap',cookies:f.cookie()});
    assert.equal(boot.json().auth.status,'verification-unavailable');
    const retryAt=Date.parse(boot.json().auth.retryAt);assert.ok(retryAt>Date.now()+58000&&retryAt<Date.now()+62000,'Bootstrap must expose the known provider deadline for the UI countdown.');
    assert.equal(f.calls(),1);
  }finally{await f.cleanup();}
});

test('periodic membership sweep performs one fresh account request before validating all of its event streams',async()=>{
  let now=Date.now(),memberCalls=0,heartbeats=0,refreshed=0;
  const id='111111111111111111';
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:30,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),fetch:async input=>{
      if(String(input).endsWith('/users/@me'))return Response.json({id,username:'Fixture'});
      memberCalls++;return Response.json({roles:[]});
    }});
  try{
    const a=await auth.completeDiscord(tokens,'device-a'),b=await auth.completeDiscord(tokens,'device-b');
    memberCalls=0;now+=60000;
    const response=()=>({destroyed:false,write:()=>{heartbeats++;},end:()=>{throw new Error('A verified stream must remain open.');}});
    const subscribers=new Set([{sid:a,deviceId:'device-a',response:response()},{sid:b,deviceId:'device-b',response:response()}]);
    await recheckMemberships(auth,{refreshPrincipal:async actor=>{assert.equal(actor.userId,id);refreshed++;}},subscribers);
    assert.equal(memberCalls,1,'The subscriber pass must reuse this sweep’s successful fresh verification.');
    assert.equal(refreshed,1);assert.equal(heartbeats,2);assert.equal(subscribers.size,2);
  }finally{auth.close();}
});

test('membership sweeps ignore idle login sessions and reuse recent proof for active streams or connected admissions',async()=>{
  const ids=['111111111111111111','222222222222222222'];let now=Date.now();const membershipTokens:string[]=[];
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:60,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:ids[0],adminRoleIds:[],explicitAdminUserIds:[]}),fetch:async(input,init)=>{
      const token=new Headers(init?.headers).get('authorization')??'';
      if(String(input).endsWith('/users/@me'))return Response.json({id:token==='Bearer account-b'?ids[1]:ids[0],username:'Fixture'});
      membershipTokens.push(token);return Response.json({roles:[]});
    }});
  try{
    const a=await auth.completeDiscord(tokens,'device-a');await auth.completeDiscord({...tokens,access_token:'account-b'},'device-b');membershipTokens.length=0;
    const response={destroyed:false,write:()=>true,end:()=>{throw new Error('Valid stream must stay open.');}};
    const subscribers=new Set([{sid:a,deviceId:'device-a',response}]);let connected=false;
    const service={refreshPrincipal:async()=>{},listAdmissions:()=>[{userId:ids[1],connected,revoked:false}]};
    now+=15000;await recheckMemberships(auth,service,subscribers);assert.equal(membershipTokens.length,0,'A background sweep must not force another request inside the successful cache.');
    now+=45000;await recheckMemberships(auth,service,subscribers);assert.deepEqual(membershipTokens,['Bearer '+tokens.access_token],'An idle eight-hour login must not consume a membership request.');
    connected=true;await recheckMemberships(auth,service,subscribers);assert.deepEqual(membershipTokens,['Bearer '+tokens.access_token,'Bearer account-b'],'Connected admissions without an event stream must still be checked.');
  }finally{auth.close();}
});

for(const rate of [{name:'full Retry-After header',header:'1337',body:1,delay:1337},{name:'JSON-only retry_after',header:undefined,body:74.5,delay:74.5}]){
  test(`Discord cooldown respects ${rate.name} without allowing sensitive or over-stale access`,async()=>{
    let now=Date.now(),limited=false,memberCalls=0;
    const id='111111111111111111';
    const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'fixture-guild',clientId:'fixture-client',clientSecret:'fixture-only',preview:false,cacheSeconds:30,maxStaleSeconds:300,now:()=>now,
      adminConfiguration:()=>({ownerUserId:id,adminRoleIds:[],explicitAdminUserIds:[]}),fetch:async input=>{
        if(String(input).endsWith('/users/@me'))return Response.json({id,username:'Fixture'});
        memberCalls++;
        return limited?Response.json({retry_after:rate.body},{status:429,headers:rate.header?{'retry-after':rate.header}:{}}):Response.json({roles:[]});
      }});
    try{
      const sid=await auth.completeDiscord(tokens,'device');now+=31000;limited=true;
      await assert.rejects(auth.principal(sid,'device',{fresh:true,allowStale:false}),error=>error instanceof AuthError&&error.code==='verification-unavailable');
      limited=false;
      assert.equal((await auth.principal(sid,'device',{allowStale:true})).userId,id);
      const firstWait=rate.delay>300?301000:31000;
      now+=firstWait;
      await assert.rejects(auth.principal(sid,'device',{fresh:true,allowStale:false}),AuthError);
      assert.equal(memberCalls,2,'No provider retry is permitted before its complete cooldown.');
      if(rate.delay>300)await assert.rejects(auth.principal(sid,'device',{allowStale:true}),AuthError);
      assert.equal(memberCalls,2,'The 300-second membership-staleness bound must not shorten provider cooldown.');
      now+=Math.ceil(rate.delay*1000)-firstWait;
      assert.equal((await auth.principal(sid,'device',{fresh:true,allowStale:false})).userId,id);
      assert.equal(memberCalls,3);
    }finally{auth.close();}
  });
}

test('Discord membership and role IDs determine authority, OAuth tokens remain encrypted',async()=>{
  const f=fixture();
  try {
    const sid=await f.auth.completeDiscord(tokens,'device-a');
    const user=await f.auth.principal(sid,'device-a');
    assert.equal(user.isAdmin,true);assert.equal(user.isOwner,false);
    assert.equal('access_token' in user,false);
    f.setRoles([]);
    assert.equal((await f.auth.principal(sid,'device-a',{fresh:true})).isAdmin,false);
    await assert.rejects(f.auth.principal(sid,'other-device'),(error:unknown)=>error instanceof AuthError&&error.status===401);
    f.auth.close();
    const data=readFileSync(f.databasePath).toString('utf8');
    assert.equal(data.includes(tokens.access_token),false);assert.equal(data.includes(tokens.refresh_token),false);
  } finally { try{f.cleanup();}catch{} }
});

test('new Discord admission fails closed for nonmembers and rate limits',async()=>{
  for(const status of [404,429]){
    const f=fixture({memberStatus:status});
    try{await assert.rejects(f.auth.completeDiscord(tokens,'device'),(error:unknown)=>error instanceof AuthError&&error.status===(status===404?403:503));}
    finally{f.cleanup();}
  }
});

test('fresh sensitive verification cannot fall back to stale successful membership',async()=>{
  const f=fixture();
  try {
    const sid=await f.auth.completeDiscord(tokens,'device');
    f.setStatus(429);f.advance(31_000);
    await assert.rejects(f.auth.principal(sid,'device',{fresh:true}),AuthError);
    assert.equal((await f.auth.principal(sid,'device',{allowStale:true})).userId,'111111111111111111');
    f.advance(301_000);
    await assert.rejects(f.auth.principal(sid,'device',{allowStale:true}),AuthError);
  }finally{f.cleanup();}
});

test('OAuth state is session/device bound, single-use and time limited',()=>{
  const f=fixture();
  try {
    const state=f.auth.createState('device-a');
    assert.equal(f.auth.consumeState(state,state,'device-b'),false);
    assert.equal(f.auth.consumeState(state,'incorrect','device-a'),false);
    assert.doesNotThrow(()=>assert.equal(f.auth.consumeState('😀'.repeat(32),state,'device-a'),false));
    assert.equal(f.auth.consumeState(state,state,'device-a'),true);
    assert.equal(f.auth.consumeState(state,state,'device-a'),false);
    const expired=f.auth.createState('device-a');f.advance(601_000);
    assert.equal(f.auth.consumeState(expired,expired,'device-a'),false);
  }finally{f.cleanup();}
});

test('concurrent verification modes share one rotating OAuth refresh token request',async()=>{
  let now=Date.now(),refreshCalls=0,invalidations=0;
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'guild',clientId:'client',clientSecret:'test-only',preview:false,cacheSeconds:30,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:'owner',adminRoleIds:[],explicitAdminUserIds:[]}),
    onInvalidAccount:async()=>{invalidations++;},
    fetch:async(input)=>{
      const url=String(input);
      if(url.endsWith('/users/@me'))return Response.json({id:'111111111111111111',username:'Test'});
      if(url.endsWith('/member'))return Response.json({roles:[]});
      const call=++refreshCalls;
      await new Promise(resolve=>setTimeout(resolve,call===1?10:30));
      return call===1?Response.json({access_token:'new-access',refresh_token:'rotated-refresh',expires_in:3600}):Response.json({error:'invalid_grant'},{status:400});
    }});
  try {
    const sid=await auth.completeDiscord(tokens,'device');now+=3_600_001;
    await Promise.all([auth.verify('111111111111111111',true,false),auth.verify('111111111111111111',true,true),auth.verify('111111111111111111',false,true)]);
    assert.equal(refreshCalls,1);assert.equal(invalidations,0);
    assert.equal((await auth.principal(sid,'device')).userId,'111111111111111111');
  }finally{auth.close();}
});

test('concurrent old-token verification shares one membership 401 and one rotating-token renewal',async()=>{
  let now=Date.now(),refreshCalls=0,initialChecks=true,oldRequests=0;
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'guild',clientId:'client',clientSecret:'test-only',preview:false,cacheSeconds:30,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:'owner',adminRoleIds:[],explicitAdminUserIds:[]}),
    fetch:async(input,init)=>{
      const url=String(input);
      if(url.endsWith('/users/@me'))return Response.json({id:'111111111111111111',username:'Test'});
      if(url.endsWith('/member')) {
        const authorization=new Headers(init?.headers).get('authorization');
        if(!initialChecks&&authorization==='Bearer '+tokens.access_token){
          const sequence=++oldRequests;await new Promise(resolve=>setTimeout(resolve,sequence===1?5:40));
          return Response.json({error:'old token'},{status:401});
        }
        return Response.json({roles:[]});
      }
      refreshCalls++;return Response.json({access_token:'new-access',refresh_token:'rotated-refresh',expires_in:3600});
    }});
  try {
    const sid=await auth.completeDiscord(tokens,'device');initialChecks=false;now+=31_000;
    await Promise.all([auth.verify('111111111111111111',true,false),auth.verify('111111111111111111',true,true)]);
    assert.equal(oldRequests,1);assert.equal(refreshCalls,1);
    assert.equal((await auth.principal(sid,'device')).userId,'111111111111111111');
  }finally{auth.close();}
});

test('known nonmember or revoked authorization cannot become stale success when media cleanup fails',async()=>{
  for(const scenario of ['nonmember','revoked'] as const) {
    let now=Date.now(),reject=false;
    const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'guild',clientId:'client',clientSecret:'test-only',preview:false,cacheSeconds:30,maxStaleSeconds:300,now:()=>now,
      adminConfiguration:()=>({ownerUserId:'owner',adminRoleIds:[],explicitAdminUserIds:[]}),
      onInvalidAccount:async()=>{throw new Error('SFU temporarily unavailable');},
      fetch:async(input)=>{
        const url=String(input);
        if(url.endsWith('/users/@me'))return Response.json({id:'111111111111111111',username:'Test'});
        if(url.endsWith('/member'))return reject&&scenario==='nonmember'?Response.json({error:'not a member'},{status:404}):Response.json({roles:[]});
        return Response.json({error:'invalid_grant'},{status:400});
      }});
    try {
      const sid=await auth.completeDiscord({...tokens,expires_in:scenario==='revoked'?90:3600},'device');reject=true;now+=31_000;
      await assert.rejects(auth.principal(sid,'device',{fresh:true,allowStale:true}),(error:unknown)=>error instanceof AuthError&&error.code===(scenario==='nonmember'?'nonmember':'authorization-revoked'));
    }finally{auth.close();}
  }
});

test('persistent membership 401 after refresh revokes admission instead of accepting stale success',async()=>{
  let now=Date.now(),deny=false,invalidations=0;
  const auth=new AuthService({databasePath:':memory:',encryptionKey:'b'.repeat(64),guildId:'guild',clientId:'client',clientSecret:'test-only',preview:false,cacheSeconds:30,maxStaleSeconds:300,now:()=>now,
    adminConfiguration:()=>({ownerUserId:'owner',adminRoleIds:[],explicitAdminUserIds:[]}),
    onInvalidAccount:async()=>{invalidations++;throw new Error('Synthetic media outage');},
    fetch:async(input)=>{
      const url=String(input);
      if(url.endsWith('/users/@me'))return Response.json({id:'111111111111111111',username:'Test'});
      if(url.endsWith('/member'))return deny?Response.json({error:'unauthorized'},{status:401}):Response.json({roles:[]});
      return Response.json({access_token:'replacement-access',refresh_token:'replacement-refresh',expires_in:3600});
    }});
  try{
    const sid=await auth.completeDiscord(tokens,'device');deny=true;now+=31_000;
    await assert.rejects(auth.principal(sid,'device',{fresh:true,allowStale:true}),(error:unknown)=>error instanceof AuthError&&error.code==='authorization-revoked');
    assert.equal(invalidations,1);assert.equal(auth.activeSessions().length,0);
    await assert.rejects(auth.principal(sid,'device'),AuthError);
  }finally{auth.close();}
});

test('preview cannot be enabled for public or production hosting',()=>{
  const base={SESSION_KEY:'a'.repeat(64),TOKEN_ENCRYPTION_KEY:'b'.repeat(64),LOCAL_PREVIEW:'true'};
  assert.throws(()=>loadConfig({...base,HOST:'0.0.0.0'}),/loopback/);
  assert.throws(()=>loadConfig({...base,NODE_ENV:'production',APP_URL:'https://stage.example.com'}),/loopback/);
});

test('direct API rejects signed-out access, spoofed admin flags, and cross-origin mutation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stage-api-'));
  const config=loadConfig({SESSION_KEY:'a'.repeat(64),TOKEN_ENCRYPTION_KEY:'b'.repeat(64),LOCAL_PREVIEW:'true',NODE_ENV:'test',DATA_DIR:dir,LIVEKIT_API_KEY:'testkey',LIVEKIT_API_SECRET:'c'.repeat(64)});
  const {app}=await createApp(config,{disableFrontend:true,quiet:true});
  const cookies:Record<string,string>={};
  const save=(response:{cookies:Array<{name:string;value:string}>})=>{for(const cookie of response.cookies)cookies[cookie.name]=cookie.value;};
  try {
    assert.equal((await app.inject({method:'GET',url:'/api/state'})).statusCode,401);
    save(await app.inject({method:'GET',url:'/api/bootstrap'}));
    const login=await app.inject({method:'POST',url:'/api/dev/login',headers:{origin:config.origin},cookies,payload:{persona:'member'}});save(login);assert.equal(login.statusCode,200);
    const spoof=await app.inject({method:'POST',url:'/api/commands',headers:{origin:config.origin},cookies,payload:{type:'session.open',mode:'stage',isAdmin:true,isOwner:true}});
    assert.equal(spoof.statusCode,403);
    const cross=await app.inject({method:'POST',url:'/api/commands',headers:{origin:'https://attacker.invalid'},cookies,payload:{type:'session.open',mode:'stage'}});
    assert.equal(cross.statusCode,403);
    assert.equal((await app.inject({method:'GET',url:'/api/auth/discord'})).statusCode,503);
    assert.equal((await app.inject({method:'POST',url:'/api/media/token',headers:{origin:config.origin},cookies,payload:{}})).statusCode,403);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('configured Discord login uses minimum scopes, PKCE, and rejects a forged callback state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stage-oauth-route-'));
  const config=loadConfig({SESSION_KEY:'a'.repeat(64),TOKEN_ENCRYPTION_KEY:'b'.repeat(64),LOCAL_PREVIEW:'false',NODE_ENV:'test',DATA_DIR:dir,DISCORD_CLIENT_ID:'111111111111111111',DISCORD_CLIENT_SECRET:'synthetic-test-only',DISCORD_GUILD_ID:'222222222222222222',DISCORD_OWNER_ID:'333333333333333333',LIVEKIT_API_KEY:'test',LIVEKIT_API_SECRET:'c'.repeat(64)});
  const {app}=await createApp(config,{disableFrontend:true,quiet:true});
  try{
    const response=await app.inject({method:'GET',url:'/api/auth/discord'});
    assert.equal(response.statusCode,302);
    const destination=new URL(response.headers.location!);
    assert.equal(destination.origin,'https://discord.com');
    assert.deepEqual(destination.searchParams.get('scope')?.split(' ').sort(),['guilds.members.read','identify']);
    assert.equal(destination.searchParams.get('code_challenge_method'),'S256');
    assert.ok(destination.searchParams.get('code_challenge'));assert.ok(destination.searchParams.get('state'));
    assert.equal(destination.searchParams.get('redirect_uri'),config.origin+'/api/auth/discord/callback');
    const cookies=Object.fromEntries(response.cookies.map(cookie=>[cookie.name,cookie.value]));
    const callback=await app.inject({method:'GET',url:'/api/auth/discord/callback?code=synthetic-code&state=forged-state',cookies});
    assert.equal(callback.statusCode,302);assert.equal(callback.headers.location,'/?authError=oauth-failed');
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
