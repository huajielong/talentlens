import {createCloudServer} from '../../cloud-server.mjs';
import * as services from '../../model-services.mjs';
import {environment,withStore,dispatchWorker} from '../runtime.mjs';
export default async function handler(request,context){
 const env={...environment(),NODE_ENV:'production',PUBLIC_URL:context.site.url,TRUST_PROXY:'1'},url=new URL(request.url);
 try{return await withStore(async store=>{
  const server=await createCloudServer(env,fetch,services,store);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  try{const headers=new Headers(request.headers);headers.delete('host');headers.delete('content-length');headers.set('x-forwarded-for',context.ip||'unknown');
   const response=await fetch('http://127.0.0.1:'+server.address().port+url.pathname+url.search,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),redirect:'manual'});
   const result=new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
   if(response.ok&&(url.pathname==='/api/tasks'||url.pathname==='/api/workspace')){
    const shouldDispatch=await store.transaction(async()=>{const pending=await store.db.prepare("SELECT id FROM tasks WHERE status='pending' LIMIT 1").get();if(!pending)return false;const row=await store.db.prepare('UPDATE worker_dispatch SET last_trigger=? WHERE id=1 AND last_trigger<? RETURNING id').get(Date.now(),Date.now()-60000);return !!row});
    if(shouldDispatch)await dispatchWorker(context.site.url,env);
   }
   return result;
  }finally{await new Promise(resolve=>server.close(resolve))}
 })}catch(error){console.error('API failure:',error.code||error.name);return Response.json({error:error.status?error.message:'云端服务暂时不可用，请稍后重试。'},{status:error.status||503,headers:{'Cache-Control':'no-store'}})}
}
export const config={path:['/api/*','/healthz']};
