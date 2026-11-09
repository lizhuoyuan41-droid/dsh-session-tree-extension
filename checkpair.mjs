import { execFileSync } from 'node:child_process'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
const dir=process.argv[2]
const text=execFileSync('zstd',['-dc',dir],{encoding:'utf8',maxBuffer:512*1024*1024})
const events=text.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l))
const header=events.shift()
const msgs=Session.create(SessionId(header.id), events).deriveMessages()
let pending=new Set(); let bad=0
for (let i=0;i<msgs.length;i++){
  const m=msgs[i]
  if (m.role==='assistant'){
    pending=new Set((m.content??[]).filter(p=>p.type==='tool-call').map(p=>p.id??p.toolCallId))
  } else if (m.role==='tool'){
    const id=m.toolCallId ?? m.content?.find?.(p=>p.type==='tool-result')?.toolCallId
    if (!pending.has(id)){
      console.log('BAD tool message at',i,'id',id,'pending',[...pending].slice(0,3),'prev roles',msgs.slice(Math.max(0,i-3),i).map(x=>x.role))
      if(++bad>3) break
    } else {
      pending.delete(id)
      // tool msgs typically come consecutively; keep pending for multi-call
    }
  } else if (pending.size>0){
    console.log('pending calls dropped at msg',i,'role',m.role,'pending',[...pending].slice(0,3))
    pending=new Set()
  }
}
console.log('messages',msgs.length,'bad',bad)
