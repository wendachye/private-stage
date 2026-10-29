import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(resolve(root,'data'),{recursive:true});
await mkdir(resolve(root,'logs'),{recursive:true});
await mkdir(resolve(root,'deploy'),{recursive:true});
if (!existsSync(resolve(root,'.env'))) {
  const key = randomBytes(32).toString('hex');
  const apiKey = 'stage_' + randomBytes(12).toString('hex');
  const apiSecret = randomBytes(32).toString('hex');
  const env = (await readFile(resolve(root,'.env.example'),'utf8'))
    .replace('LOCAL_PREVIEW=false','LOCAL_PREVIEW=true')
    .replace('SESSION_KEY=','SESSION_KEY='+key)
    .replace('TOKEN_ENCRYPTION_KEY=','TOKEN_ENCRYPTION_KEY='+randomBytes(32).toString('hex'))
    .replace('LIVEKIT_API_KEY=','LIVEKIT_API_KEY='+apiKey)
    .replace('LIVEKIT_API_SECRET=','LIVEKIT_API_SECRET='+apiSecret);
  await writeFile(resolve(root,'.env'),env,{flag:'wx'});
  console.log('Created .env with unique local keys and loopback-only preview. Secrets were not printed.');
} else console.log('Existing .env retained.');
const env = await readFile(resolve(root,'.env'),'utf8');
const value = name => env.match(new RegExp('^'+name+'=(.*)$','m'))?.[1]?.trim();
await writeFile(resolve(root,'deploy/livekit.local.yaml'),[
  '# Local-only signaling; Docker port mappings also bind to 127.0.0.1.',
  'port: 7880',
  'bind_addresses:',
  '  - 0.0.0.0',
  'rtc:',
  '  tcp_port: 7881',
  '  udp_port: 7882',
  '  use_external_ip: false',
  '  node_ip: 127.0.0.1',
  'keys:',
  '  '+value('LIVEKIT_API_KEY')+': '+value('LIVEKIT_API_SECRET'),
  'room:',
  '  auto_create: false',
  'logging:',
  '  level: warn',
  ''
].join('\n'));
console.log('Local LiveKit configuration written. Run the media-start script, then npm run dev.');
