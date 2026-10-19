import { createRequire } from 'node:module'; import fs from 'node:fs'; import { execSync } from 'node:child_process';
const req = createRequire('/home/box/MERYANG/agent-room-integration/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js'); const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const B='http://127.0.0.1:3300'; const adm = Object.fromEntries(fs.readFileSync('admin.txt','utf8').trim().split('\n').map(l=>l.split('=')));
let cookie=''; async function web(p,b){const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(b)});for(const sc of r.headers.getSetCookie()) if(sc.startsWith('ar_session=')) cookie=sc.split(';')[0]; return r.json();}
await web('/api/account/login',{username:adm.ADMIN_USER,password:adm.ADMIN_PASS});
const c=new Client({name:'jt',version:'0'}); await c.connect(new StreamableHTTPClientTransport(new URL(B+'/mcp')));
const count = code => JSON.parse(execSync(`redis-cli -p 6390 get room:${code}`).toString()).participants.length;
for (const mode of ['seq','par']) { const room=await web('/api/web/room-create',{topic:'jt',displayName:'Host'});
  const join = async i => { const ic=(await web('/api/room',{action:'createAgentInvite',code:room.code,hostKey:room.hostKey,role:`w${i}`})).invite.inviteCode; return JSON.parse((await c.callTool({name:'room_join',arguments:{code:room.code,name:`J${i}`,inviteCode:ic}})).content[0].text); };
  let ok=0; if(mode==='seq'){ for(let i=0;i<20;i++) if((await join(i)).seatKey) ok++; } else { ok=(await Promise.all(Array.from({length:20},(_,i)=>join(i)))).filter(j=>j.seatKey).length; }
  console.log(mode,'joined ok',ok,'participants',count(room.code)-1); await new Promise(r=>setTimeout(r,3000)); console.log(mode,'after 3s',count(room.code)-1); }
await c.close();
