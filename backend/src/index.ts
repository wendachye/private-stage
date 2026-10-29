import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const config=loadConfig();
const {app}=await createApp(config,{disableFrontend:process.argv.includes('--api-only')});
await app.listen({host:config.HOST,port:config.PORT});
console.log(`Private Stage ready at ${config.APP_URL}${config.preview?' (loopback-only local preview)':''}`);
let shuttingDown=false;
const shutdown=()=>{
  if(shuttingDown)return;
  shuttingDown=true;
  void app.close().then(()=>process.exit(0),()=>process.exit(1));
};
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,shutdown);
// Only an IPC-enabled local parent can send this message. The Windows launcher
// uses it to drain Fastify, SSE, media connections, and SQLite before exiting.
process.on('message',(message:unknown)=>{
  if(message&&typeof message==='object'&&'type' in message&&message.type==='private-stage:shutdown')shutdown();
});
if(process.send)process.once('disconnect',shutdown);
