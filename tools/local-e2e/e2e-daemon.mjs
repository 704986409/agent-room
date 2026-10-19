import { createRequire } from 'node:module'; import fs from 'node:fs'; import { createHash } from 'node:crypto'; import { execSync, spawn } from 'node:child_process';
const req = createRequire('/home/box/MERYANG/agent-room-integration/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js'); const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const B='http://127.0.0.1:3300'; const adm = Object.fromEntries(fs.readFileSync('admin.txt','utf8').trim().split('\n').map(l=>l.split('=')));
const rc=(...a)=>execSync(`redis-cli -p 6390 ${a.map(x=>`'${x}'`).join(' ')}`).toString().trim();
let cookie=''; async function web(p,b){const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(b)});for(const sc of r.headers.getSetCookie()) if(sc.startsWith('ar_session=')) cookie=sc.split(';')[0]; return r.json();}
const TOK='daemon-dev-'+Date.now(); rc('SET',`device-cred:${createHash('sha256').update(TOK).digest('hex')}`,'dev-daemon-1');
await web('/api/account/login',{username:adm.ADMIN_USER,password:adm.ADMIN_PASS});
const room=await web('/api/web/room-create',{topic:'daemon e2e',displayName:'Host'}); const code=room.code;
const ic=(await web('/api/room',{action:'createAgentInvite',code,hostKey:room.hostKey,role:'coder'})).invite.inviteCode;
const c=new Client({name:'d',version:'0'}); await c.connect(new StreamableHTTPClientTransport(new URL(B+'/mcp'))); const j=JSON.parse((await c.callTool({name:'room_join',arguments:{code,name:'Sleeper',inviteCode:ic}})).content[0].text); j.name=j.name??j.yourName??'Sleeper'; await c.close();
const reg=await (await fetch(B+'/api/wake',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${TOK}`},body:JSON.stringify({action:'register',code,name:j.name,seatKey:j.seatKey,cursor:j.cursor})})).json();
console.log('reg',JSON.stringify(reg),'join',j.name,j.cursor,j.error??''); fs.writeFileSync('mock-seat.json',JSON.stringify({seatKey:j.seatKey})); fs.mkdirSync('daemon-state',{recursive:true});
fs.writeFileSync('daemon-state/state.json',JSON.stringify({seats:[{seatId:reg.seatId,code,name:j.name,adapterId:'codex',sessionId:'mock-thread',cwd:'/tmp',status:'idle'}]}));
const d=spawn('npx',['tsx','tools/wake-agent/src/index.ts','serve','--state','/home/box/MERYANG/localtest/daemon-state/state.json','--server',B],{cwd:'/home/box/MERYANG/agent-room-integration',env:{...process.env,PATH:`/home/box/MERYANG/localtest/mockbin:${process.env.PATH}`,AGENT_ROOM_DEVICE_TOKEN:TOK}});
let dlog=''; d.stderr.on('data',x=>dlog+=x); d.stdout.on('data',x=>dlog+=x);
await new Promise(r=>setTimeout(r,3000)); const t0=Date.now();
await web('/api/web/chat-send',{code,text:`@${j.name} wake up and reply`});
let ok=false, state=''; for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,1000)); const k=rc('--scan','--pattern',`wake-evt:wk:*:${reg.seatId}`).split('\n').filter(Boolean)[0]; state=k?JSON.parse(rc('GET',k)).state:'none'; if(state==='SUCCEEDED'){ok=true;break;} }
const msgs=rc('LRANGE',`room-msgs:${code}`,'0','-1'); const replied=/mock agent: done/.test(msgs);
const ho=rc('GET',`seat-handoff:${reg.roomInstanceId}:${reg.seatId}`);
console.log(`${ok&&replied?'PASS':'FAIL'} 4.daemon-mock-agent-end-to-end state=${state} replied=${replied} latency=${Date.now()-t0}ms handoff=${ho}`);
console.log(`${/managed=1/.test(fs.existsSync('mock-codex.log')&&fs.readFileSync('mock-codex.log','utf8'))?'PASS':'FAIL'} 4.daemon-sets-AGENT_ROOM_MANAGED`);
d.kill('SIGTERM'); setTimeout(()=>process.exit(0),1500); console.log('--- daemon log tail\n'+dlog.split('\n').slice(-8).join('\n'));
