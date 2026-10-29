import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Principal, AdminConfiguration } from '../../../shared/types.ts';

export class AuthError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSeconds?:number) { super(message); }
}
type OAuthTokens = { access_token: string; refresh_token?: string; expires_at?: string | number | Date; expires_in?: number; token_type?: string };
type StoredTokens = { access: string; refresh?: string; expiresAt: number };
interface Account { id:string; name:string; avatar:string|null; tokens:string|null; roles:string; verified_at:number; retry_at:number; last_failure:string|null; }
interface AuthSession { id:string; account_id:string; device_id:string; preview:number; expires_at:number; }
type Fetcher = typeof fetch;
export interface DiscordQuotaDiagnostic {
  endpoint: 'identity' | 'membership' | 'token_refresh';
  status: number;
  limit?: number;
  remaining?: number;
  resetAfter?: number;
  retryAfter?: number;
  scope?: 'user' | 'global' | 'shared';
  global?: boolean;
}

export class AuthService {
  private db: DatabaseSync;
  private key: Buffer;
  private checks = new Map<string,Promise<Account>>();
  private refreshes = new Map<string,Promise<StoredTokens>>();
  constructor(private options: {
    databasePath:string; encryptionKey:string; guildId:string; clientId:string; clientSecret:string;
    preview:boolean; cacheSeconds:number; maxStaleSeconds:number;
    adminConfiguration:()=>AdminConfiguration;
    onInvalidAccount?:(userId:string,reason:string)=>Promise<void>;
    onDiscordQuota?:(diagnostic:DiscordQuotaDiagnostic)=>void;
    fetch?:Fetcher; now?:()=>number;
  }) {
    mkdirSync(dirname(options.databasePath),{recursive:true});
    this.key = Buffer.from(options.encryptionKey,'hex');
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS auth_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,avatar TEXT,tokens TEXT,roles TEXT NOT NULL DEFAULT '[]',verified_at INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,last_failure TEXT);
      CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,device_id TEXT NOT NULL,preview INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY,device_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_provider_limits(scope TEXT PRIMARY KEY,retry_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT OR IGNORE INTO auth_migrations VALUES(1,datetime('now'));`);
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private globalRetryAt() { return (this.db.prepare('SELECT retry_at FROM auth_provider_limits WHERE scope=?').get('global') as {retry_at:number}|undefined)?.retry_at??0; }
  private retryAt(id?:string) { return Math.max(id?this.account(id)?.retry_at??0:0,this.globalRetryAt()); }
  private limited(id?:string,message='Discord is rate limiting verification. Please try again shortly.') {
    const retry=Math.max(0,Math.ceil((this.retryAt(id)-this.now())/1000));
    return new AuthError(503,'verification-unavailable',message,retry||undefined);
  }
  private recordQuota(id:string|undefined,response:Response,body?:{retry_after?:unknown;global?:unknown}|null) {
    const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;
    const header=(name:string)=>{const raw=response.headers.get(name);return raw?.trim()?numeric(Number(raw)):undefined;};
    const delays:number[]=[];
    if(response.status===429){
      for(const value of [header('retry-after'),numeric(body?.retry_after),header('x-ratelimit-reset-after')])if(value!==undefined)delays.push(value);
      if(!delays.length)delays.push(30);
    }else if(header('x-ratelimit-remaining')===0){const reset=header('x-ratelimit-reset-after');if(reset!==undefined)delays.push(reset);}
    if(!delays.length)return;
    const deadline=this.now()+Math.ceil(Math.max(response.status===429?1:0,...delays)*1000);
    if(body?.global===true||response.headers.get('x-ratelimit-global')==='true'||response.headers.get('x-ratelimit-scope')==='global'){
      this.db.prepare('INSERT INTO auth_provider_limits VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET retry_at=MAX(retry_at,excluded.retry_at)').run('global',deadline);
    }else if(id)this.db.prepare('UPDATE auth_accounts SET retry_at=MAX(retry_at,?) WHERE id=?').run(deadline,id);
  }
  private encrypt(tokens:StoredTokens) {
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const body=Buffer.concat([cipher.update(JSON.stringify(tokens),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
  }
  private decrypt(value:string):StoredTokens {
    const data=Buffer.from(value,'base64'), decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));
    decipher.setAuthTag(data.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8'));
  }
  private account(id:string) { return this.db.prepare('SELECT * FROM auth_accounts WHERE id=?').get(id) as unknown as Account|undefined; }
  private observeQuota(response:Response,endpoint:DiscordQuotaDiagnostic['endpoint']) {
    if(!this.options.onDiscordQuota)return;
    const names=['x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset-after','retry-after','x-ratelimit-scope','x-ratelimit-global'];
    if(response.status!==429&&!names.some(name=>response.headers.has(name)))return;
    const number=(value:unknown):number|undefined=>{
      if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:undefined;
      if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value.trim()))return undefined;
      const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;
    };
    const emit=(body:unknown)=>{
      const details=body&&typeof body==='object'?body as {retry_after?:unknown;global?:unknown}:{};
      const diagnostic:DiscordQuotaDiagnostic={endpoint,status:response.status};
      for(const [field,header] of [['limit','x-ratelimit-limit'],['remaining','x-ratelimit-remaining'],['resetAfter','x-ratelimit-reset-after']] as const){
        const value=number(response.headers.get(header));if(value!==undefined)diagnostic[field]=value;
      }
      const retry=[number(response.headers.get('retry-after')),number(details.retry_after)].filter((value):value is number=>value!==undefined);
      if(retry.length)diagnostic.retryAfter=Math.max(...retry);
      const scope=response.headers.get('x-ratelimit-scope');
      if(scope==='user'||scope==='global'||scope==='shared')diagnostic.scope=scope;
      const globalHeader=response.headers.get('x-ratelimit-global');
      if(typeof details.global==='boolean'||globalHeader==='true'||globalHeader==='false')diagnostic.global=details.global===true||globalHeader==='true';
      try{this.options.onDiscordQuota?.(diagnostic);}catch{}
    };
    // Diagnostics never block or consume the caller's response. Only numeric
    // quota values and closed enums leave this boundary; no URL, ID, or body.
    if(response.status===429)void response.clone().json().then(emit,()=>emit(null));
    else emit(null);
  }
  private async request(path:string, token:string,endpoint:DiscordQuotaDiagnostic['endpoint']) {
    const response=await (this.options.fetch ?? fetch)('https://discord.com/api/v10'+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});
    this.observeQuota(response,endpoint);
    return response;
  }
  private normalize(tokens:OAuthTokens):StoredTokens {
    return {access:tokens.access_token,refresh:tokens.refresh_token,expiresAt:tokens.expires_at ? new Date(tokens.expires_at).getTime() : this.now()+(tokens.expires_in ?? 3600)*1000};
  }
  private createSession(accountId:string,deviceId:string,preview:boolean) {
    const id=randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?)').run(id,accountId,deviceId,preview?1:0,this.now()+8*60*60*1000);
    return id;
  }
  createState(deviceId:string) {
    const state=randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(this.now());
    this.db.prepare('INSERT INTO oauth_states VALUES(?,?,?)').run(createHash('sha256').update(state).digest('hex'),deviceId,this.now()+10*60*1000);
    return state;
  }
  consumeState(state:unknown,expected:unknown,deviceId:string) {
    if(typeof state!=='string'||typeof expected!=='string') return false;
    const actualBytes=Buffer.from(state),expectedBytes=Buffer.from(expected);
    if(actualBytes.length!==expectedBytes.length||!timingSafeEqual(actualBytes,expectedBytes)) return false;
    const hash=createHash('sha256').update(state).digest('hex');
    const row=this.db.prepare('DELETE FROM oauth_states WHERE hash=? AND device_id=? AND expires_at>=? RETURNING hash').get(hash,deviceId,this.now());
    return !!row;
  }
  async completeDiscord(tokens:OAuthTokens,deviceId:string) {
    if(this.globalRetryAt()>this.now())throw this.limited();
    const normalized=this.normalize(tokens);
    const response=await this.request('/users/@me',normalized.access,'identity');
    if(response.status===429){const body=await response.json().catch(()=>null);this.recordQuota(undefined,response,body);throw this.limited(undefined,'Discord identity could not be verified.');}
    if(!response.ok) throw new AuthError(503,'verification-unavailable','Discord identity could not be verified.');
    const user=await response.json() as {id:string;global_name?:string;username:string;avatar?:string};
    if(!/^\d{15,22}$/.test(user.id)) throw new AuthError(503,'verification-unavailable','Discord returned an invalid identity.');
    const name=user.global_name||user.username;
    const avatar=user.avatar?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=80`:null;
    this.db.prepare(`INSERT INTO auth_accounts(id,name,avatar,tokens) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,tokens=excluded.tokens`).run(user.id,name,avatar,this.encrypt(normalized));
    await this.verify(user.id,false,false);
    return this.createSession(user.id,deviceId,false);
  }
  previewLogin(persona:string,deviceId:string) {
    if(!this.options.preview) throw new AuthError(404,'not-found','Local preview is disabled.');
    const personas:Record<string,[string,string]>={owner:['preview-owner','Alex · Owner'],admin:['preview-admin','Sam · Admin'],member:['preview-member','Jordan · Member'],member2:['preview-member2','Riley · Member'],member3:['preview-member3','Casey · Member']};
    const choice=personas[persona];
    if(!choice) throw new AuthError(400,'invalid-persona','Choose a known local preview persona.');
    this.db.prepare(`INSERT INTO auth_accounts(id,name,roles,verified_at) VALUES(?,?,'[]',?) ON CONFLICT(id) DO UPDATE SET verified_at=excluded.verified_at`).run(choice[0],choice[1],this.now());
    return this.createSession(choice[0],deviceId,true);
  }
  private async notifyInvalid(id:string,reason:string) {
    // A known auth denial stays a denial even if downstream SFU cleanup is unavailable.
    // Admission is denied by authentication; the media controller also retries its own sweep.
    try { await this.options.onInvalidAccount?.(id,reason); } catch {}
  }
  private async revokeAuthorization(id:string) {
    this.db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(id);
    this.db.prepare('UPDATE auth_accounts SET tokens=NULL,verified_at=0,last_failure=? WHERE id=?').run('authorization-revoked',id);
    await this.notifyInvalid(id,'authorization-revoked');
  }
  private refresh(account:Account,tokens:StoredTokens):Promise<StoredTokens> {
    const pending=this.refreshes.get(account.id);
    if(pending) return pending;
    // A delayed 401 may refer to an access token another request has already replaced.
    const canonical=this.account(account.id);
    if(!canonical?.tokens) return Promise.reject(new AuthError(401,'authorization-revoked','Sign in to Discord again.'));
    const latest=this.decrypt(canonical.tokens);
    if((latest.access!==tokens.access||latest.refresh!==tokens.refresh)&&latest.expiresAt>this.now()+60_000) return Promise.resolve(latest);
    const refresh=this.refreshInner(canonical,latest).finally(()=>this.refreshes.delete(account.id));
    this.refreshes.set(account.id,refresh);
    return refresh;
  }
  private async refreshInner(account:Account,tokens:StoredTokens):Promise<StoredTokens> {
    if(!tokens.refresh) {
      await this.revokeAuthorization(account.id);
      throw new AuthError(401,'authorization-revoked','Please sign in to Discord again.');
    }
    if(this.globalRetryAt()>this.now())throw this.limited(account.id);
    const response=await (this.options.fetch ?? fetch)('https://discord.com/api/oauth2/token',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens.refresh,client_id:this.options.clientId,client_secret:this.options.clientSecret}),
      signal:AbortSignal.timeout(8000)
    });
    this.observeQuota(response,'token_refresh');
    if(response.status===429){const body=await response.json().catch(()=>null);this.recordQuota(account.id,response,body);throw this.limited(account.id,'Discord token renewal is temporarily rate limited.');}
    if(response.status===400||response.status===401) {
      await this.revokeAuthorization(account.id);
      throw new AuthError(401,'authorization-revoked','Discord authorization expired or was revoked. Sign in again.');
    }
    if(!response.ok) throw new AuthError(503,'verification-unavailable','Discord token renewal is temporarily unavailable.');
    const updated=this.normalize(await response.json() as OAuthTokens);
    updated.refresh ||= tokens.refresh;
    this.db.prepare('UPDATE auth_accounts SET tokens=? WHERE id=?').run(this.encrypt(updated),account.id);
    return updated;
  }
  private async verifyInner(id:string):Promise<Account> {
    const account=this.account(id);
    if(!account?.tokens) throw new AuthError(401,'signed-out','Sign in to Discord.');
    try {
      let tokens=this.decrypt(account.tokens);
      if(tokens.expiresAt<this.now()+60_000) tokens=await this.refresh(account,tokens);
      let response=await this.request(`/users/@me/guilds/${this.options.guildId}/member`,tokens.access,'membership');
      if(response.status===401) { tokens=await this.refresh(account,tokens); response=await this.request(`/users/@me/guilds/${this.options.guildId}/member`,tokens.access,'membership'); }
      if(response.status===401){
        await this.revokeAuthorization(id);
        throw new AuthError(401,'authorization-revoked','Discord authorization is no longer valid. Sign in again.');
      }
      if(response.status===403||response.status===404) {
        this.db.prepare('UPDATE auth_accounts SET verified_at=0,last_failure=? WHERE id=?').run('nonmember',id);
        await this.notifyInvalid(id,'nonmember');
        throw new AuthError(403,'nonmember','This account is not an eligible member of the configured Discord server.');
      }
      if(response.status===429) {
        const body=await response.json().catch(()=>null);
        this.recordQuota(id,response,body);
        throw this.limited(id);
      }
      if(!response.ok) throw new AuthError(503,'verification-unavailable','Discord membership verification is temporarily unavailable.');
      const member=await response.json() as {roles?:string[];pending?:boolean};
      if(member.pending) {
        this.db.prepare('UPDATE auth_accounts SET verified_at=0,last_failure=? WHERE id=?').run('nonmember',id);
        await this.notifyInvalid(id,'membership-screening-required');
        throw new AuthError(403,'nonmember','Complete Discord server membership screening first.');
      }
      if(!Array.isArray(member.roles)||member.roles.some(role=>typeof role!=='string')) throw new AuthError(503,'verification-unavailable','Discord returned an invalid membership response.');
      this.recordQuota(id,response);
      this.db.prepare('UPDATE auth_accounts SET roles=?,verified_at=?,retry_at=CASE WHEN retry_at>? THEN retry_at ELSE 0 END,last_failure=NULL WHERE id=?').run(JSON.stringify(member.roles),this.now(),this.now(),id);
      return this.account(id)!;
    } catch(error) {
      if(error instanceof AuthError && error.status<500) throw error;
      this.db.prepare('UPDATE auth_accounts SET last_failure=? WHERE id=?').run('verification-unavailable',id);
      throw error instanceof AuthError?error:new AuthError(503,'verification-unavailable','Discord is temporarily unreachable.');
    }
  }
  async verify(id:string,fresh=false,allowStale=false) {
    const account=this.account(id);
    if(!account?.tokens)throw new AuthError(401,'signed-out','Sign in to Discord.');
    if(!fresh&&account.verified_at>0&&this.now()-account.verified_at<this.options.cacheSeconds*1000)return account;
    try{
      if(this.retryAt(id)>this.now())throw this.limited(id);
      // The shared promise is always a strict network result. Each caller
      // applies its own stale policy only after that same request fails.
      let pending=this.checks.get(id);
      if(!pending){pending=this.verifyInner(id).finally(()=>this.checks.delete(id));this.checks.set(id,pending);}
      return await pending;
    }catch(error){
      if(error instanceof AuthError&&error.status<500)throw error;
      const current=this.account(id);
      const age=current?this.now()-current.verified_at:Infinity;
      if(allowStale&&current?.tokens&&current.verified_at>0&&age<=this.options.maxStaleSeconds*1000)return current;
      if(current?.verified_at&&age>this.options.maxStaleSeconds*1000)await this.notifyInvalid(id,'membership-verification-expired');
      throw error;
    }
  }
  async principal(sessionId:string|undefined,deviceId:string|undefined,opts:{fresh?:boolean;allowStale?:boolean}={}):Promise<Principal> {
    if(!sessionId||!deviceId) throw new AuthError(401,'signed-out','Sign in to continue.');
    const session=this.db.prepare('SELECT * FROM auth_sessions WHERE id=? AND device_id=? AND expires_at>?').get(sessionId,deviceId,this.now()) as unknown as AuthSession|undefined;
    if(!session) throw new AuthError(401,'signed-out','Your session expired. Sign in again.');
    const account=session.preview&&this.options.preview?this.account(session.account_id):await this.verify(session.account_id,opts.fresh,opts.allowStale);
    if(!account) throw new AuthError(401,'signed-out','Sign in to continue.');
    // Verification can yield while logout, account replacement, or expiry ends
    // this device's session. A late provider response must not authorize it.
    const current=this.db.prepare('SELECT id FROM auth_sessions WHERE id=? AND account_id=? AND device_id=? AND expires_at>?').get(sessionId,account.id,deviceId,this.now());
    if(!current) throw new AuthError(401,'signed-out','Your session expired. Sign in again.');
    return this.identity(account,deviceId,!!session.preview);
  }
  private identity(account:Account,deviceId:string,preview:boolean):Principal {
    const config=this.options.adminConfiguration();
    const roles=JSON.parse(account.roles) as string[];
    const isOwner=account.id===config.ownerUserId;
    const isAdmin=isOwner||config.explicitAdminUserIds.includes(account.id)||roles.some(role=>config.adminRoleIds.includes(role))||(preview&&account.id==='preview-admin');
    return {userId:account.id,displayName:account.name,...(account.avatar?{avatarUrl:account.avatar}:{}),isOwner,isAdmin,deviceId};
  }
  async principalForAccount(userId:string):Promise<Principal> {
    if(this.options.preview&&userId.startsWith('preview-')) {
      const account=this.account(userId);if(!account)throw new AuthError(503,'verification-unavailable','Target identity is not available.');
      return this.identity(account,'authority-check',true);
    }
    return this.identity(await this.verify(userId,false,false),'authority-check',false);
  }
  activeSessions() { return this.db.prepare('SELECT * FROM auth_sessions WHERE expires_at>?').all(this.now()) as unknown as AuthSession[]; }
  logout(id:string|undefined) { if(id) this.db.prepare('DELETE FROM auth_sessions WHERE id=?').run(id); }
  close() { this.db.close(); }
}
