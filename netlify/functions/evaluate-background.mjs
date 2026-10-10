import core from '../../dist/core.js';
import {evaluate} from '../../model-services.mjs';
import {environment,verifyWorker,withStore,meteredFetch,dispatchWorker} from '../runtime.mjs';
export default async function handler(request,context){
 const env=environment();if(request.method!=='POST'||!verifyWorker(request,env))return;
 const deadline=Date.now()+10*60000;
 await withStore(async store=>{
  while(Date.now()<deadline){
   const task=await store.nextTask();if(!task)break;
   try{const user=await store.db.prepare('SELECT * FROM users WHERE id=? AND company_id=? AND enabled=1').get(task.actorId,task.companyId);if(!user)throw Error('发起账号已停用。');const actor={id:user.id,companyId:user.company_id,role:user.role,name:user.name},result=await evaluate(task.login,task.job,{...env,MODEL_TIMEOUT_MS:'60000'},meteredFetch(store,actor),task.force);await store.complete(task,result)}
   catch(error){if(await store.taskStatus(task.id)!=='cancelled')await store.setTask(task,'failed',error.name==='TimeoutError'?'接口超时，请重试。':error.message)}
  }
  if(await store.db.prepare("SELECT id FROM tasks WHERE status='pending' LIMIT 1").get())await dispatchWorker(context.site.url,env);
 });
}
export const config={background:true};
