// Opt-in packaging regression. Uses only fresh Docker resources and fake keys;
// no host ports, network, local .env, private data or existing volume is used.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

if (!process.argv.includes('--run')) {
  console.log('Build the image, then run: node deploy/check-backend-container.mjs --run --image private-stage-backend:local');
  process.exit(0);
}
const imageIndex = process.argv.indexOf('--image');
const image = imageIndex >= 0 ? process.argv[imageIndex + 1] : 'private-stage-backend:local';
if (!image || image.startsWith('-')) throw new Error('Supply the local image tag after --image.');
const runId = randomUUID();
const prefix = `private-stage-check-${runId}`;
const volume = `${prefix}-data`;
const primary = `${prefix}-primary`;
const contender = `${prefix}-contender`;
const resources = [];
let createdVolume = false;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inspect = name => JSON.parse(docker('inspect', name))[0];
const assert = (value, message) => { if (!value) throw new Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
const inContainer = (name, source) => docker('exec', name, 'node', '--input-type=module', '-e', source);
const health = async name => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = inspect(name).State;
    if (state.Health?.Status === 'healthy') return;
    if (!state.Running) throw new Error(`Rehearsal container exited (${state.ExitCode}) before becoming healthy.`);
    await pause();
  }
  throw new Error('Rehearsal container did not become healthy within the bounded wait.');
};
const exited = async name => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = inspect(name).State;
    if (!state.Running) return state.ExitCode;
    await pause();
  }
  throw new Error('Contending container failed to exit within the bounded wait.');
};
const create = name => {
  docker('create', '--name', name, '--label', `private-stage-check=${runId}`, '--init', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp',
    '--volume', `${volume}:/var/lib/private-stage`, '--health-interval', '1s', '--health-start-period', '0s',
    '--env', 'NODE_ENV=production', '--env', 'LOCAL_PREVIEW=false',
    '--env', 'APP_URL=https://api.example.com', '--env', 'FRONTEND_URL=https://app.example.com',
    '--env', `SESSION_KEY=${'a'.repeat(64)}`, '--env', `TOKEN_ENCRYPTION_KEY=${'b'.repeat(64)}`,
    '--env', 'DISCORD_CLIENT_ID=', '--env', 'DISCORD_CLIENT_SECRET=', '--env', 'DISCORD_GUILD_ID=',
    '--env', 'DISCORD_OWNER_ID=', '--env', 'LIVEKIT_API_KEY=', '--env', 'LIVEKIT_API_SECRET=', image);
  resources.push(name);
};

try {
  docker('image', 'inspect', image); // Require an already built local image.
  docker('volume', 'create', '--label', `private-stage-check=${runId}`, volume);
  createdVolume = true;
  create(primary);
  docker('start', primary);
  await health(primary);
  const state = inspect(primary);
  assert(state.Config.User === 'node', 'The runtime must use the non-root node user.');
  assert(state.HostConfig.NetworkMode === 'none' && Object.values(state.NetworkSettings.Ports ?? {}).every(bindings => !bindings?.length), 'Rehearsal isolation failed.');
  const lockSnapshot = inContainer(primary, "import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('/var/lib/private-stage/app.lock','utf8'))");
  console.log('PASS isolated image starts healthy as node with no network or published ports');

  create(contender);
  docker('start', contender);
  const contenderExit = await exited(contender);
  assert(contenderExit === 73, 'A second container did not refuse the shared volume before Node startup.');
  assert(inContainer(primary, "import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('/var/lib/private-stage/app.lock','utf8'))") === lockSnapshot, 'The refused container modified the active application lock.');
  await health(primary);
  console.log('PASS concurrent container refused with exit 73; original lock and healthy writer preserved');

  docker('kill', '--signal', 'KILL', primary);
  assert(inspect(primary).State.ExitCode === 137, 'Crash rehearsal did not produce SIGKILL exit 137.');
  docker('start', primary);
  await health(primary);
  console.log('PASS SIGKILL followed by restart recovers the same managed data volume');

  const result = inContainer(primary, `
    import http from 'node:http';
    import {existsSync} from 'node:fs';
    const assert=(v,m)=>{if(!v)throw new Error(m)};
    const request=(path,headers,method='GET')=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:3210,path,headers,method,timeout:2000},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}))});r.on('error',reject);r.on('timeout',()=>r.destroy());r.end()});
    const allowed={host:'api.example.com',origin:'https://app.example.com'};
    const b=await request('/api/bootstrap',allowed);
    const body=JSON.parse(b.body);
    assert(b.status===200&&b.headers['access-control-allow-origin']===allowed.origin&&b.headers['access-control-allow-credentials']==='true','credentialed CORS failed');
    assert(body.configuration.discordConfigured===false&&body.configuration.mediaConfigured===false&&!body.localPreview,'fixture configuration is not isolated');
    assert(b.headers['set-cookie']?.length>0&&b.headers['set-cookie'].every(c=>/HttpOnly/i.test(c)&&/SameSite=Lax/i.test(c)&&/Secure/i.test(c)&&!/;\\s*Domain=/i.test(c)),'cookie security failed');
    const p=await request('/api/commands',{...allowed,'access-control-request-method':'POST','access-control-request-headers':'content-type'},'OPTIONS');
    assert(p.status===204,'preflight failed');
    const o=await request('/api/bootstrap',{host:allowed.host,origin:'https://untrusted.example.net'});
    assert(o.status===403&&!o.headers['access-control-allow-origin'],'unknown origin accepted');
    assert((await request('/healthz',{host:'untrusted.example.net'})).status===403,'unknown Host accepted');
    assert(!existsSync('/workspace/.env')&&!existsSync('/workspace/frontend/app')&&!existsSync('/workspace/node_modules/next'),'private environment or frontend included in API image');
    console.log('PASS API-only credentialed CORS, secure host-only cookie, preflight, rejected origin/Host and image boundary');
  `);
  console.log(result);
  docker('stop', '--time', '10', primary);
  assert(inspect(primary).State.ExitCode === 0, 'Graceful shutdown did not exit zero.');
  const lockState = docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
    '--volume', `${volume}:/var/lib/private-stage`, image, '--input-type=module', '-e',
    "import {existsSync} from 'node:fs';if(existsSync('/var/lib/private-stage/app.lock')||!existsSync('/var/lib/private-stage/container.lock'))process.exit(1)");
  assert(lockState === '', 'Unexpected lock inspection output.');
  console.log('PASS graceful shutdown exits zero, removes app.lock and retains the OS-lock inode');
} finally {
  for (const name of resources.reverse()) {
    const owned = inspect(name).Config.Labels?.['private-stage-check'] === runId;
    if (!owned) throw new Error('Refusing cleanup of a container without this rehearsal label.');
    docker('rm', '--force', name);
  }
  if (createdVolume) {
    const owned = JSON.parse(docker('volume', 'inspect', volume))[0].Labels?.['private-stage-check'] === runId;
    if (!owned) throw new Error('Refusing cleanup of a volume without this rehearsal label.');
    docker('volume', 'rm', volume);
  }
  console.log('Removed only this rehearsal\'s labelled containers and fictional-data volume.');
}
