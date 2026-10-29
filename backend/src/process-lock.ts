import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Protect startup reconciliation from a second process touching the same database. */
export function acquireProcessLock(directory:string) {
  const path=join(directory,'app.lock');
  const token=randomUUID();
  const write=()=>{
    const descriptor=openSync(path,'wx',0o600);
    try{writeFileSync(descriptor,JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}));}finally{closeSync(descriptor);}
  };
  try{write();}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    // Serialize recovery and reread the main lock AFTER claiming recovery. Otherwise two
    // starts could both inspect a dead PID and one could delete the other's replacement.
    const recoveryPath=path+'.recover';
    let recovery:number;
    try{recovery=openSync(recoveryPath,'wx',0o600);}catch{throw new Error('Another startup is recovering the app lock. Retry after it finishes; verify a stale recovery claim manually.');}
    try{
      writeFileSync(recovery,JSON.stringify({pid:process.pid,token}));
      let old:{pid:number};
      try{old=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('The app lock is unreadable. Verify no Private Stage process is running before recovering it.');}
      if(!Number.isSafeInteger(old.pid)||old.pid<=0)throw new Error('The app lock has an invalid process ID. Verify it manually before recovery.');
      let active=true;
      try{process.kill(old.pid,0);}catch(failure){if((failure as NodeJS.ErrnoException).code==='ESRCH')active=false;}
      if(active)throw new Error('Private Stage is already using this data directory. A second instance was refused before database reconciliation.');
      unlinkSync(path);write();
    }finally{closeSync(recovery);try{if(JSON.parse(readFileSync(recoveryPath,'utf8')).token===token)unlinkSync(recoveryPath);}catch{}}
  }
  return ()=>{
    try{if(JSON.parse(readFileSync(path,'utf8')).token===token)unlinkSync(path);}catch{}
  };
}
