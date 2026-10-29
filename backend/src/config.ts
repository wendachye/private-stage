import { config as loadEnvironment } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Keep the desktop's private configuration/data stable when npm changes cwd.
// A separately deployed backend instead anchors files to its own package.
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(backendRoot, '..');
function configurationRoot() {
  let manifest: { workspaces?: string[] | { packages?: string[] } };
  try { manifest = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return backendRoot; throw error; }
  const packages = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
  const equivalent = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  return packages.some(value => equivalent(resolve(workspaceRoot, value)) === equivalent(backendRoot)) ? workspaceRoot : backendRoot;
}
export const projectRoot = configurationRoot();
loadEnvironment({ path: resolve(projectRoot, '.env'), quiet: true });

const schema = z.object({
  APP_NAME: z.string().default('Private Stage'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3210),
  APP_URL: z.url().default('http://localhost:3210'),
  FRONTEND_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  NODE_ENV: z.enum(['development','production','test']).default('development'),
  LOCAL_PREVIEW: z.enum(['true','false']).default('false'),
  SESSION_KEY: z.string().regex(/^[a-f0-9]{64}$/i,'Run npm run setup to generate SESSION_KEY.'),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i,'Run npm run setup to generate TOKEN_ENCRYPTION_KEY.'),
  DATA_DIR: z.string().default('./data'),
  DISCORD_CLIENT_ID: z.string().default(''),
  DISCORD_CLIENT_SECRET: z.string().default(''),
  DISCORD_GUILD_ID: z.string().default(''),
  DISCORD_OWNER_ID: z.string().default(''),
  DISCORD_ADMIN_ROLE_IDS: z.string().default(''),
  LIVEKIT_INTERNAL_URL: z.url().default('http://127.0.0.1:7880'),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),
  MEMBERSHIP_CACHE_SECONDS: z.coerce.number().int().min(0).max(60).default(60),
  MEMBERSHIP_RECHECK_SECONDS: z.coerce.number().int().min(10).max(120).default(60),
  MEMBERSHIP_MAX_STALE_SECONDS: z.coerce.number().int().min(30).max(300).default(300),
});

export function loadConfig(env: Record<string,string|undefined> = process.env) {
  const settings = schema.parse(env);
  if (settings.MEMBERSHIP_CACHE_SECONDS > settings.MEMBERSHIP_MAX_STALE_SECONDS) throw new Error('The membership cache cannot exceed the maximum verification age.');
  const url = new URL(settings.APP_URL);
  const frontendUrl = new URL(settings.FRONTEND_URL ?? settings.APP_URL);
  if (![url, frontendUrl].every(value => ['http:', 'https:'].includes(value.protocol) && !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash)) throw new Error('APP_URL and FRONTEND_URL require HTTP(S) origins without credentials, paths, queries or fragments.');
  const preview = settings.LOCAL_PREVIEW === 'true';
  const loopback = ['127.0.0.1','localhost','[::1]'];
  if (preview && (settings.NODE_ENV === 'production' || !loopback.includes(settings.HOST) || !loopback.includes(url.hostname) || !loopback.includes(frontendUrl.hostname))) {
    throw new Error('LOCAL_PREVIEW is allowed only on loopback in development/test.');
  }
  if (settings.NODE_ENV === 'production' && (url.protocol !== 'https:' || frontendUrl.protocol !== 'https:')) throw new Error('Production APP_URL and FRONTEND_URL require trusted HTTPS.');
  const missing = ['DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_GUILD_ID','DISCORD_OWNER_ID'].filter(name => !settings[name as keyof typeof settings]);
  const discordConfigured = missing.length === 0;
  return {
    ...settings, preview, discordConfigured, missing,
    dataDir: resolve(projectRoot, settings.DATA_DIR),
    cookieSecure: url.protocol === 'https:',
    origin: url.origin,
    frontendOrigin: frontendUrl.origin,
    ownerUserId: preview ? 'preview-owner' : settings.DISCORD_OWNER_ID,
    adminRoleIds: settings.DISCORD_ADMIN_ROLE_IDS.split(',').map(x=>x.trim()).filter(Boolean),
    mediaConfigured: !!settings.LIVEKIT_API_KEY && settings.LIVEKIT_API_SECRET.length >= 32,
  };
}
export type Config = ReturnType<typeof loadConfig>;
