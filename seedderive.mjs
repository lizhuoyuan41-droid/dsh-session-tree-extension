import { execFileSync } from 'node:child_process'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { sessionPrefixForkSeed } from '@ryanlee2007/dsh-pi-agent-session-tree'
const dir=process.argv[2]
const text=execFileSync('zstd',['-dc',dir],{encoding:'utf8',maxBuffer:512*1024*1024})
const all=text.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l))
const header=all.shift()
const source=Session.create(SessionId(header.id), all)
const lastUser=all.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user').at(-1)
const seed=sessionPrefixForkSeed(source,[{nodeId:'x',parentId:null,type:'message',branch:'main',summary:'',createdAt:'',metadata:{sessionEventSeq:lastUser.seq}}],SessionId('child-test'))
const child=Session.create(SessionId('child-test'), seed)
const pm=source.deriveMessages(); const cm=child.deriveMessages()
function bad(msgs){let pending=new Set(),n=0;for(const m of msgs){if(m.role==='assistant')pending=new Set((m.content??[]).filter(p=>p.type==='tool-call').map(p=>p.id??p.toolCallId));else if(m.role==='tool'){const id=m.toolCallId??m.content?.find?.(p=>p.type==='tool-result')?.toolCallId;if(!pending.has(id))n++;else pending.delete(id)}else if(pending.size>0)pending=new Set()}return n}
console.log('parent msgs',pm.length,'bad',bad(pm))
console.log('child msgs',cm.length,'bad',bad(cm),'seed events',seed.length)
