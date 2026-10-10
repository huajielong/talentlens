import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {request} from 'node:http';
import {createLegacyServer as createServer} from './server.mjs';
const criteria=[{id:'react',name:'React',weight:3,requirement:'React',sourceQuote:'React',observable:true,rubric:{zero:'反向证据',partial:'项目线索',strong:'明确贡献'},verificationQuestion:'职责？'}];
const job={title:'前端',summary:'React',jd:'React',criteria};
let calls=0;
const fixture=async(url)=>{
 if(url.endsWith('/chat/completions')){calls++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'公开项目线索',assessments:[{criterionId:'react',score:70,confidence:'low',reason:'项目技术栈',evidenceIds:['repo-0'],verificationQuestion:'职责？'}]})}}]})}}
 if(url.includes('/repos?'))return {ok:true,json:async()=>[{name:'react',language:'JavaScript',topics:['react'],html_url:'https://github.com/example/react'}]};
 if(url.includes('/readme')||url.includes('/contents'))return {ok:false,status:404};
 return {ok:true,json:async()=>({login:'example',type:'Organization',html_url:'https://github.com/example'})};
};
const server=createServer({DEEPSEEK_API_KEY:'fixture',TALENTLENS_DATA_DIR:mkdtempSync(path.join(os.tmpdir(),'talentlens-http-'))},fixture);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
try{
 const saved={id:'a',title:'岗位 A',jd:'React',job,skills:criteria,people:[],tracked:[],accounts:'example'};
 assert.equal((await post('/api/workspace',{jobs:[saved,{...saved,id:'b',title:'岗位 B'}]})).status,200);
 // Split a Chinese character between request chunks; decoding each chunk separately corrupts it.
 const unicodeTitle='跨团队共性需求抽象';
 const payload=Buffer.from(JSON.stringify({jobs:[{...saved,title:unicodeTitle},{...saved,id:'b',title:'岗位 B'}]}));
 const split=payload.indexOf(Buffer.from('跨'))+1;
 const status=await new Promise((resolve,reject)=>{const req=request(base+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.write(payload.subarray(0,split));setTimeout(()=>req.end(payload.subarray(split)),25)});
 assert.equal(status,200);
 assert.equal((await (await fetch(base+'/api/workspace')).json()).jobs[0].title,unicodeTitle);
 assert.equal((await post('/api/tasks',{jobId:'a',logins:Array.from({length:11},(_,i)=>'account'+i)})).status,400);
 assert.equal((await post('/api/tasks',{jobId:'a',logins:['example','example']})).status,202);
 let data;
 for(let i=0;i<50;i++){data=await (await fetch(base+'/api/workspace')).json();if(data.tasks.every(t=>!['pending','running'].includes(t.status)))break;await new Promise(r=>setTimeout(r,20))}
 assert.equal(calls,1);assert.equal(data.jobs[0].people.length,1);assert.equal(data.jobs[1].people.length,0);assert.equal(data.tasks[0].status,'done');
 assert.equal((await fetch(base+'/core.js')).status,200);
 console.log('PASS: HTTP persistence, 10-account limit, deduplicated background evaluation, independent job results and static core module.');
}finally{await new Promise(resolve=>server.close(resolve))}
