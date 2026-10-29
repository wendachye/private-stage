import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import secureSession from '@fastify/secure-session';
import oauth2 from '@fastify/oauth2';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { projectRoot, type Config } from './config.ts';
import { AuthService, AuthError } from './auth/auth-service.ts';
import { StageService, DomainError } from './domain/stage-service.ts';
import { createMediaController } from './media/controller.ts';
import type { Principal } from '../../shared/types.ts';
import { acquireProcessLock } from './process-lock.ts';

declare module '@fastify/secure-session' {
  interface SessionData { sid:string; deviceId:string; oauthState:string }
}

const sensitive = (type:string) => !['room.leave','mic.acquire','mic.release','share.reserve','share.confirm','share.release','hand.set','chat.send','chat.react','reaction.send'].includes(type);

interface MembershipSubscriber {
  sid:string;
  deviceId:string;
  response:{destroyed:boolean;write(chunk:string):unknown;end():unknown};
}

/** One membership sweep shared by the periodic job and its regression fixture. */
export async function recheckMemberships(auth:Pick<AuthService,'principal'|'activeSessions'>,service:{refreshPrincipal(actor:Principal):Promise<unknown>;listAdmissions?():Array<{userId:string;revoked:boolean;connected:boolean}>},subscribers:Set<MembershipSubscriber>) {
  // Refresh each account first. A successful check then supplies the ordinary
  // membership cache for all of its event streams instead of checking twice.
  const checked=new Set<string>();
  const activeSessions=new Set([...subscribers].filter(item=>!item.response.destroyed).map(item=>item.sid));
  const activeAccounts=new Set(service.listAdmissions?.().filter(item=>!item.revoked&&item.connected).map(item=>item.userId)??[]);
  for(const session of auth.activeSessions()){
    if(!activeSessions.has(session.id)&&!activeAccounts.has(session.account_id))continue;
    if(checked.has(session.account_id))continue;checked.add(session.account_id);
    try{await service.refreshPrincipal(await auth.principal(session.id,session.device_id,{allowStale:true}));}catch{}
  }
  for(const subscriber of subscribers) {
    try {await auth.principal(subscriber.sid,subscriber.deviceId,{allowStale:true});subscriber.response.write(': heartbeat\n\n');}
    catch {subscriber.response.write('event: access-ended\ndata: {}\n\n');subscriber.response.end();subscribers.delete(subscriber);}
  }
}

export async function createApp(config:Config, options:{disableFrontend?:boolean;quiet?:boolean;fetch?:typeof fetch}={}) {
  mkdirSync(config.dataDir,{recursive:true});
  const releaseLock=acquireProcessLock(config.dataDir);
  const app=Fastify({
    logger:options.quiet?false:{level:'info',redact:['req.headers.cookie','req.headers.authorization','res.headers.set-cookie'],serializers:{req:(req)=>({method:req.method,url:req.url?.split('?')[0]})}},
    bodyLimit:32*1024, trustProxy:false,
  });
  // HTTP server.close does not drain upgraded sockets. Next dev HMR and any
  // other accepted upgrades must not keep shutdown waiting for onClose.
  const upgradedSockets=new Set<Duplex>();
  let stopping=false;
  const trackUpgrade=(_request:IncomingMessage,socket:Duplex)=>{
    if(stopping){socket.destroy();return;}
    upgradedSockets.add(socket);
    socket.once('close',()=>upgradedSockets.delete(socket));
  };
  app.server.on('upgrade',trackUpgrade);
  await app.register(secureSession,{
    key:Buffer.from(config.SESSION_KEY,'hex'),cookieName:'stage_session',expiry:8*60*60,
    cookie:{path:'/',httpOnly:true,sameSite:'lax',secure:config.cookieSecure,maxAge:8*60*60},
  });
  await app.register(helmet,{
    contentSecurityPolicy:false,
    crossOriginEmbedderPolicy:false,
    strictTransportSecurity:config.cookieSecure?undefined:false,
  });
  await app.register(rateLimit,{max:(request)=>request.session.get('sid')?1200:180,timeWindow:'1 minute',keyGenerator:(request)=>request.session.get('sid')??request.ip});
  const subscribers=new Set<MembershipSubscriber>();
  const broadcast=()=>{
    for(const subscriber of subscribers) if(!subscriber.response.destroyed) subscriber.response.write('event: invalidate\ndata: {}\n\n');
  };
  let service:StageService;
  let auth:AuthService;
  const frontendOrigin=config.frontendOrigin??config.origin;
  const allowedHosts=new Set([new URL(config.APP_URL).hostname,...(config.HOST==='127.0.0.1'?['127.0.0.1','localhost']:[])]);
  const backendHostAllowed=(request:IncomingMessage)=>allowedHosts.has((request.headers.host??'').split(':')[0]);
  const appendHeaderToken=(reply:FastifyReply,name:string,token:string)=>{
    const value=reply.getHeader(name);
    const tokens=(Array.isArray(value)?value:[String(value??'')]).flatMap(item=>item.split(',')).map(item=>item.trim()).filter(Boolean);
    if(name.toLowerCase()==='vary'&&tokens.includes('*'))return;
    if(!tokens.some(item=>item.toLowerCase()===token.toLowerCase()))reply.header(name,[...tokens,token].join(', '));
  };
  const apiResponseHeaders=(request:FastifyRequest,reply:FastifyReply)=>{
    if(!request.url.startsWith('/api/'))return;
    reply.header('Cache-Control','no-store');
    if(request.headers.origin!==frontendOrigin||!backendHostAllowed(request.raw))return;
    reply.header('Access-Control-Allow-Origin',frontendOrigin);
    reply.header('Access-Control-Allow-Credentials','true');
    appendHeaderToken(reply,'Vary','Origin');
    appendHeaderToken(reply,'Access-Control-Expose-Headers','Retry-After');
  };
  const frontendLocation=(suffix='')=>frontendOrigin===config.origin?'/'+suffix:frontendOrigin+'/'+suffix;
  const requireOrigin=(request:IncomingMessage,mandatory=true)=>{
    const origin=request.headers.origin;
    if((mandatory&&!origin)||(origin&&origin!==frontendOrigin)) throw new AuthError(403,'origin-rejected','This action must originate from the application.');
  };
  const media=createMediaController({
    livekitUrl:config.LIVEKIT_INTERNAL_URL,apiKey:config.LIVEKIT_API_KEY,apiSecret:config.LIVEKIT_API_SECRET,
    async authorize(request,identity,roomName) {
      try {
        requireOrigin(request,request.headers.upgrade?.toLowerCase()==='websocket');
        const cookie=app.parseCookie(request.headers.cookie??'').stage_session;
        const session=cookie?app.decodeSecureSession(cookie):null;
        const principal=await auth.principal(session?.get('sid'),session?.get('deviceId'),{allowStale:true});
        const admission=service.getAdmission(identity);
        if(!admission||admission.userId!==principal.userId||admission.deviceId!==principal.deviceId||admission.roomName!==roomName) return null;
        return service.mediaPolicy(identity);
      } catch { return null; }
    },
    onConnection:async(identity,connected)=>{await service.setConnection(identity,connected);},
    onPublicationStopped:async(identity,source,reservationId)=>{if(source==='screen_share')await service.releaseShareByIdentity(identity,reservationId);},log:app.log,
  });
  service=new StageService({databasePath:resolve(config.dataDir,'stage.sqlite'),ownerUserId:config.ownerUserId,adminRoleIds:config.adminRoleIds,
    media:{reconcile:(room,policies)=>media.reconcile(room,policies),remove:(room,identity)=>media.remove(room,identity),closeRoom:(room)=>media.closeRoom(room),mute:(room,identity)=>media.mute(room,identity)},onChange:broadcast});
  auth=new AuthService({databasePath:resolve(config.dataDir,'auth.sqlite'),encryptionKey:config.TOKEN_ENCRYPTION_KEY,guildId:config.DISCORD_GUILD_ID,clientId:config.DISCORD_CLIENT_ID,clientSecret:config.DISCORD_CLIENT_SECRET,preview:config.preview,cacheSeconds:config.MEMBERSHIP_CACHE_SECONDS,maxStaleSeconds:config.MEMBERSHIP_MAX_STALE_SECONDS,adminConfiguration:()=>service.getAdminConfiguration(),onInvalidAccount:async(userId,reason)=>{await service.invalidateAccount(userId,reason);broadcast();},onDiscordQuota:diagnostic=>app.log.info({discordQuota:diagnostic},'Discord API quota observed'),fetch:options.fetch});

  app.addHook('onRequest',async(request,reply)=>{
    const isApi=request.url.startsWith('/api/');
    if(isApi) reply.header('Cache-Control','no-store');
    const hostname=(request.headers.host??'').split(':')[0];
    if(hostname&&!backendHostAllowed(request.raw)) throw new AuthError(403,'host-rejected','Unrecognized application host.');
    if(isApi&&request.headers.origin){
      requireOrigin(request.raw);
      apiResponseHeaders(request,reply);
    }
    if(request.method!=='GET'&&request.method!=='HEAD'&&request.method!=='OPTIONS') requireOrigin(request.raw);
  });
  // Include approved-origin headers even when an earlier hook sends an error.
  // Hijacked SSE bypasses onSend and keeps the onRequest policy above.
  app.addHook('onSend',async(request,reply,payload)=>{apiResponseHeaders(request,reply);return payload;});
  app.options('/api/*',async(request,reply)=>{
    requireOrigin(request.raw);
    const method=request.headers['access-control-request-method'];
    const requested=(request.headers['access-control-request-headers']??'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
    const allowedHeaders=new Set(['content-type','x-requested-with','x-csrf-token']);
    if(!method||!['GET','POST'].includes(method)||requested.some(value=>!allowedHeaders.has(value))) throw new AuthError(403,'cors-preflight-rejected','This cross-origin request is not supported.');
    return reply.header('Access-Control-Allow-Methods','GET, POST')
      .header('Access-Control-Allow-Headers','Content-Type, X-Requested-With, X-CSRF-Token')
      .header('Access-Control-Max-Age','600').code(204).send();
  });
  const device=(request:FastifyRequest)=>{
    let id=request.session.get('deviceId');
    if(!id){id=randomUUID();request.session.set('deviceId',id);} return id;
  };
  const principal=(request:FastifyRequest,fresh=false,allowStale=true)=>auth.principal(request.session.get('sid'),device(request),{fresh,allowStale});

  if(config.discordConfigured) {
    await app.register(oauth2,{
      name:'discordOAuth',scope:['identify','guilds.members.read'],pkce:'S256',hostPrefixedCookies:config.cookieSecure,
      credentials:{client:{id:config.DISCORD_CLIENT_ID,secret:config.DISCORD_CLIENT_SECRET},auth:oauth2.DISCORD_CONFIGURATION,options:{authorizationMethod:'body'}},
      callbackUri:config.origin+'/api/auth/discord/callback',
      generateStateFunction(request){const value=auth.createState(device(request));request.session.set('oauthState',value);return value;},
      checkStateFunction(request){
        const state=(request.query as {state?:string}).state;
        const valid=auth.consumeState(state,request.session.get('oauthState'),device(request));
        request.session.set('oauthState',undefined as never);return valid;
      },
      cookie:{httpOnly:true,sameSite:'lax',secure:config.cookieSecure,path:'/',maxAge:600},
    });
    app.get('/api/auth/discord',async(request,reply)=>{
      const provider=app.oauth2DiscordOAuth!;
      reply.redirect(await provider.generateAuthorizationUri(request,reply));
    });
    app.get('/api/auth/discord/callback',async(request,reply)=>{
      try {
        const {token}=await app.oauth2DiscordOAuth!.getAccessTokenFromAuthorizationCodeFlow(request,reply);
        const sid=await auth.completeDiscord(token,device(request));
        auth.logout(request.session.get('sid'));
        request.session.set('sid',sid);
        return reply.redirect(frontendLocation());
      } catch(error) {
        const code=error instanceof AuthError?error.code:'oauth-failed';
        return reply.redirect(frontendLocation('?authError='+encodeURIComponent(code)));
      }
    });
  } else {
    app.get('/api/auth/discord',async(_request,reply)=>reply.code(503).send({error:'missing-configuration',message:'Discord login is not configured. Follow docs/discord-setup.md; keep the client secret local.'}));
  }
  app.post('/api/auth/logout',async(request)=>{
    try {const user=await principal(request);await service.execute(user,{type:'room.leave'});} catch{}
    auth.logout(request.session.get('sid'));request.session.set('sid',undefined as never);return {ok:true};
  });
  app.post('/api/dev/login',async(request)=>{
    if(!config.preview) throw new AuthError(404,'not-found','Local preview is disabled.');
    const persona=(request.body as {persona?:unknown})?.persona;
    if(typeof persona!=='string') throw new AuthError(400,'invalid-persona','Choose a preview persona.');
    auth.logout(request.session.get('sid'));
    request.session.set('sid',auth.previewLogin(persona,device(request)));
    return {ok:true};
  });
  app.get('/api/bootstrap',async(request)=>{
    const deviceId=device(request);
    let user:Principal|undefined,status='signed-out',retryAt:string|undefined;
    try{user=await principal(request);status='authenticated';}catch(error){if(error instanceof AuthError&&['nonmember','verification-unavailable'].includes(error.code)){status=error.code;if(error.retryAfterSeconds)retryAt=new Date(Date.now()+error.retryAfterSeconds*1000).toISOString();}}
    return {appName:config.APP_NAME,localPreview:config.preview,configuration:{discordConfigured:config.discordConfigured,mediaConfigured:config.mediaConfigured,missing:config.missing},auth:{status,...(user?{user}:{}),...(retryAt?{retryAt}:{})},deviceId};
  });
  app.get('/api/state',async(request)=>service.snapshot(await principal(request)));
  app.post('/api/commands',async(request)=>{
    const command=request.body as {type?:unknown};
    if(!command||typeof command.type!=='string')throw new AuthError(400,'invalid-command','Choose a valid room action.');
    const actor=await principal(request,false,!sensitive(command.type));
    if(command.type==='member.remove'&&!actor.isOwner) {
      const targetId=(command as {userId?:unknown}).userId;
      if(typeof targetId!=='string')throw new AuthError(400,'invalid-target','Choose a participant.');
      await service.refreshPrincipal(await auth.principalForAccount(targetId));
    }
    if(command.type==='share.confirm'){
      const admission=service.snapshot(actor).self.admission;
      if(!admission||!await media.hasScreen(admission.identity,admission.roomName))throw new AuthError(409,'publication-not-confirmed','No screen publication was confirmed by the media server.');
    }
    return service.execute(actor,command);
  });
  app.post('/api/media/token',async(request)=>{
    // An existing device admission was freshly verified by room.join. Reuse a
    // current successful membership cache entry, but never stale fallback,
    // before issuing its credential; admission and policy are checked below.
    const actor=await principal(request,false,false);
    const snapshot=service.snapshot(actor);
    const admission=snapshot.self.admission;
    if(!admission||admission.revoked)throw new AuthError(403,'admission-required','Join the live session before connecting media.');
    const policy=service.mediaPolicy(admission.identity);
    if(!policy?.active)throw new AuthError(403,'admission-revoked','Your media admission is no longer active.');
    await media.ensureRoom(policy.roomName);
    return {token:await media.issueToken(policy),serverUrl:config.origin.replace(/^http/,'ws')};
  });
  app.get('/rtc/validate',async(request,reply)=>{
    try {await media.validate(request.raw);return reply.code(200).send({ok:true});}
    catch{return reply.code(403).send({error:'media-admission-denied'});}
  });
  app.get('/rtc/v1/validate',async(_request,reply)=>reply.code(404).send({error:'unsupported-signal-protocol'}));
  app.get('/rtc/v1',async(_request,reply)=>reply.code(404).send({error:'unsupported-signal-protocol'}));
  app.get('/api/events',async(request,reply)=>{
    await principal(request);
    const sid=request.session.get('sid')!,deviceId=device(request);
    // Cookie already exists after bootstrap; no new session needs to be committed here.
    for(const [name,value] of Object.entries(reply.getHeaders()))if(value!==undefined)reply.raw.setHeader(name,value);
    reply.hijack();
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
    reply.raw.write('event: invalidate\ndata: {}\n\n');
    const subscriber={response:reply.raw,sid,deviceId};subscribers.add(subscriber);
    request.raw.on('close',()=>subscribers.delete(subscriber));
  });
  app.get('/healthz',async()=>({ok:true,service:'private-stage',preview:config.preview}));
  app.get('/api/admin/health',async(request)=>{
    const user=await principal(request,false,false);if(!user.isAdmin)throw new AuthError(403,'forbidden','Admin access is required.');
    return {ok:true,media:await media.health(),cleanupPending:service.snapshot(user).cleanupPending};
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof AuthError||error instanceof DomainError){
      const retryAfterSeconds=error instanceof AuthError?error.retryAfterSeconds:undefined;
      if(retryAfterSeconds)reply.header('Retry-After',String(retryAfterSeconds));
      return reply.code(error.status).send({error:error.code,message:error.message,...(retryAfterSeconds?{retryAfterSeconds}:{})});
    }
    const candidate=error as {statusCode?:number;code?:string;message?:string;retryAfterSeconds?:number};
    const status=typeof candidate.statusCode==='number'?candidate.statusCode:500;
    if(status===429){
      const delays=[Number(reply.getHeader('Retry-After')),candidate.retryAfterSeconds].filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0);
      const retryAfterSeconds=delays.length?Math.ceil(Math.max(...delays)):undefined;
      if(retryAfterSeconds)reply.header('Retry-After',String(retryAfterSeconds));
      return reply.code(429).send({error:candidate.code??'rate-limited',message:candidate.message||'Too many requests. Try again shortly.',...(retryAfterSeconds?{retryAfterSeconds}:{})});
    }
    if(status>=500)app.log.warn({requestId:request.id,errorCode:(error as {code?:string}).code??'internal'},'Request failed');
    return reply.code(status).send({error:status>=500?'service-unavailable':'invalid-request',message:status>=500?'The action could not be completed. Try again or check local service health.':'The request is invalid.'});
  });
  try{await service.startupClose();}catch{app.log.warn('Previous media cleanup is pending; room admission remains closed.');}
  media.attach(app.server);
  let sweepBusy=false;
  const ticker=setInterval(async()=>{
    if(sweepBusy)return;sweepBusy=true;
    try{
      await recheckMemberships(auth,service,subscribers);
      for(const admission of service.listAdmissions()){
        if(!admission.revoked&&admission.connected){const policy=service.mediaPolicy(admission.identity);if(!policy?.active)await media.remove(admission.roomName,admission.identity);}
      }
    }finally{sweepBusy=false;}
  },config.MEMBERSHIP_RECHECK_SECONDS*1000);ticker.unref();
  let maintenanceBusy=false;
  const maintenance=setInterval(async()=>{
    if(maintenanceBusy)return;maintenanceBusy=true;
    try{if(service.hasCleanupPending())await service.startupClose();await service.prune();}catch{app.log.warn('Media reservation cleanup is pending.');}finally{maintenanceBusy=false;}
  },2000);maintenance.unref();
  let frontend:{close():Promise<void>}|undefined;
  if(!options.disableFrontend){
    const {default:next}=await import('next');
    const nextApp=next({dir:resolve(projectRoot,'frontend'),dev:config.NODE_ENV!=='production',hostname:config.HOST,port:config.PORT});
    await nextApp.prepare();frontend=nextApp;
    const handler=nextApp.getRequestHandler();
    app.setNotFoundHandler(async(request,reply)=>{
      if(/^\/(?:api|rtc|healthz)(?:\/|\?|$)/.test(request.url))return reply.code(404).send({error:'not-found'});
      for(const [name,value] of Object.entries(reply.getHeaders()))if(value!==undefined)reply.raw.setHeader(name,value);
      reply.hijack();await handler(request.raw,reply.raw);
    });
  }
  app.addHook('preClose',async()=>{
    stopping=true;
    clearInterval(ticker);clearInterval(maintenance);for(const subscriber of subscribers)subscriber.response.end();subscribers.clear();
    await media.close();
    for(const socket of upgradedSockets)socket.destroy();upgradedSockets.clear();
    await frontend?.close();
  });
  app.addHook('onClose',async()=>{
    app.server.off('upgrade',trackUpgrade);auth.close();service.close();releaseLock();
  });
  await app.ready();
  return {app,service,auth,media};
}
