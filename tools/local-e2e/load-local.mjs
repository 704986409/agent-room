// Local wake poll load: N devices, each owning one registered agent seat; devices poll /api/wake at the
// server's nextPollMs (5s) with jitter; a sender posts @mentions once per second to measure pickup.
import { createRequire } from 'node:module'; import fs from 'node:fs'; import { createHash } from 'node:crypto'; import { execSync, exec } from 'node:child_process';
const req = createRequire('/home/box/MERYANG/agent-room-integration/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js'); const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const B='http://127.0.0.1:3300'; const N=Number(process.argv[2]||500), PER_ROOM=50, DUR=Number(process.argv[3]||60)*1000;
const adm = Object.fromEntries(fs.readFileSync('/home/box/MERYANG/localtest/admin.txt','utf8').trim().split('\n').map(l=>l.split('=')));
let cookie=''; async function web(p,b){const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(b)});for(const sc of r.headers.getSetCookie()) if(sc.startsWith('ar_session=')) cookie=sc.split(';')[0]; return r.json();}
await web('/api/account/login',{username:adm.ADMIN_USER,password:adm.ADMIN_PASS});
const rooms=[]; for(let i=0;i<Math.ceil(N/PER_ROOM);i++){ rooms.push(await web('/api/web/room-create',{topic:`load ${i}`,displayName:'Host'})); }
const devices=[]; const t0=Date.now(); const pipe=[];
const c=new Client({name:'load',version:'0'}); await c.connect(new StreamableHTTPClientTransport(new URL(B+'/mcp')));
async function setup(i){ const room=rooms[Math.floor(i/PER_ROOM)]; const ic=(await web('/api/room',{action:'createAgentInvite',code:room.code,hostKey:room.hostKey,role:`worker${i}`})).invite.inviteCode;
  const name=`A${i}`; const j=JSON.parse((await c.callTool({name:'room_join',arguments:{code:room.code,name,inviteCode:ic}})).content[0].text); if(!j.seatKey && i<60) console.log('joinerr',i,JSON.stringify(j).slice(0,200));
  const tok=`load-${i}-${Date.now()}`; pipe.push(`SET device-cred:${createHash('sha256').update(tok).digest('hex')} dev-load-${i}`);
  devices.push({i,tok,code:room.code,name,seatKey:j.seatKey,cursor:j.cursor}); }
for(let i=0;i<N;i+=PER_ROOM){ for(let k=i;k<Math.min(N,i+PER_ROOM);k+=10) await Promise.all(Array.from({length:Math.min(10,N-k,i+PER_ROOM-k)},(_,x)=>setup(k+x))); }
fs.writeFileSync('/tmp/load-creds.txt',pipe.join('\n')+'\n'); execSync('redis-cli -p 6390 < /tmp/load-creds.txt > /dev/null'); fs.unlinkSync('/tmp/load-creds.txt');
const wake=async(d,body)=>{ const s=performance.now(); const r=await fetch(B+'/api/wake',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${d.tok}`},body:JSON.stringify(body)}); const j=await r.json(); return {s:r.status,j,ms:performance.now()-s}; };
let regErr=0; for(let i=0;i<N;i+=50) await Promise.all(devices.slice(i,i+50).map(async d=>{ const r=await wake(d,{action:'register',code:d.code,name:d.name,seatKey:d.seatKey,cursor:d.cursor}); d.seatId=r.j.seatId; if(!d.seatId){ regErr++; if(regErr<3) console.log('regerr',JSON.stringify(r.j),d.seatKey?'hasKey':'noKey'); } }));
console.log(`setup ${N} devices/seats in ${rooms.length} rooms: ${((Date.now()-t0)/1000).toFixed(1)}s, register errors ${regErr}`);
const serverPid = execSync("ss -ltnp | grep ':3300 ' | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2").toString().trim(); const srhPid = execSync("ss -ltnp | grep ':8090 ' | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2").toString().trim();
const cpu = pid => { const f=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' '); return Number(f[11])+Number(f[12]); };
const lat=[]; let errs=0, reqs=0; const pickup=[]; let stop=false; const sentAt=new Map();
const cpu0={s:cpu(serverPid),p:cpu(srhPid),t:Date.now()};
const redisLatP=new Promise(res=>exec(`timeout ${Math.floor(DUR/1000)-5} redis-cli -p 6390 --latency 2>/dev/null; true`,{shell:'/bin/bash'},(e,o)=>res(String(o).trim().split(/\r|\n/).filter(Boolean).pop()??'')));
devices.forEach(async d=>{ await new Promise(r=>setTimeout(r,Math.random()*5000)); while(!stop){ try{ const r=await wake(d,{action:'poll'}); reqs++; lat.push(r.ms); if(r.s!==200) errs++; else { const p=r.j.seats?.[0]?.pending??[]; if(p.length && sentAt.has(d.name)){ pickup.push(Date.now()-sentAt.get(d.name)); sentAt.delete(d.name); } }
  await new Promise(res=>setTimeout(res,(r.j?.nextPollMs??5000)*(0.8+Math.random()*0.4))); }catch{ errs++; await new Promise(res=>setTimeout(res,5000)); } } });
(async()=>{ while(!stop){ await new Promise(r=>setTimeout(r,1000)); const d=devices[Math.floor(Math.random()*N)]; if(sentAt.has(d.name)||!d.seatId) continue; sentAt.set(d.name,Date.now()); await web('/api/web/chat-send',{code:d.code,text:`@${d.name} load ping`}); } })();
await new Promise(r=>setTimeout(r,DUR)); stop=true; const redisLat=await redisLatP;
const el=(Date.now()-cpu0.t)/1000; const sCpu=(cpu(serverPid)-cpu0.s)/100/el*100, pCpu=(cpu(srhPid)-cpu0.p)/100/el*100;
lat.sort((a,b)=>a-b); pickup.sort((a,b)=>a-b); const q=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(a.length*p))].toFixed(0):'n/a';
const mem=execSync("redis-cli -p 6390 info memory | grep used_memory_human").toString().trim();
const out={devices:N,rooms:rooms.length,durationS:el.toFixed(0),pollReqs:reqs,rps:(reqs/el).toFixed(1),errors:errs,pollLatencyMs:{p50:q(lat,.5),p95:q(lat,.95),p99:q(lat,.99),max:q(lat,1)},mentionPickupMs:{n:pickup.length,p50:q(pickup,.5),p99:q(pickup,.99)},apiCpuPct:sCpu.toFixed(0),restShimCpuPct:pCpu.toFixed(0),redis:{latency:redisLat,mem}};
console.log(JSON.stringify(out,null,1)); fs.writeFileSync(`/home/box/MERYANG/localtest/load-${N}.json`,JSON.stringify(out,null,1)); await c.close(); process.exit(0);
