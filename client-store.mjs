import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readFileSync,readdirSync,unlinkSync} from 'node:fs';
import {randomUUID,randomBytes,createHash,scrypt as rawScrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
import core from './dist/core.js';
const scrypt=promisify(rawScrypt),now=()=>new Date().toISOString();
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const problem=(status,message)=>Object.assign(new Error(message),{status});
export async function passwordHash(password){
 if(typeof password!=='string'||password.length<12||password.length>128)throw problem(400,'密码须为 12–128 个字符。');
 const salt=randomBytes(16).toString('hex'),key=await scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:192*1024*1024});
 return 'scrypt:'+salt+':'+key.toString('hex');
}
export async function passwordMatches(password,hash){
 if(typeof password!=='string'||password.length>128)return false;
 const [,salt,encoded]=hash.split(':'),key=await scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:192*1024*1024});
 return timingSafeEqual(key,Buffer.from(encoded,'hex'));
}
const publicUser=u=>({id:u.id,username:u.username,name:u.name,role:u.role,enabled:!!u.enabled,mustChangePassword:!!u.must_change,companyId:u.company_id});
export class ClientStore{
 constructor(directory){
  mkdirSync(directory,{recursive:true});this.directory=directory;this.db=new DatabaseSync(path.join(directory,'talentlens.sqlite'));
  if(this.db.prepare('PRAGMA user_version').get().user_version>1){this.db.close();throw Error('数据库版本高于当前程序，请使用匹配的应用版本。')}
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,name TEXT NOT NULL,daily_calls INTEGER NOT NULL DEFAULT 100,daily_tokens INTEGER NOT NULL DEFAULT 1000000,consent_version TEXT NOT NULL DEFAULT '2026-10-v1');
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','consultant')),enabled INTEGER NOT NULL DEFAULT 1,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL,touched INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),owner_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),owner_id TEXT NOT NULL REFERENCES users(id),job_id TEXT NOT NULL REFERENCES jobs(id),status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),user_id TEXT NOT NULL REFERENCES users(id),day TEXT NOT NULL,reserved INTEGER NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audits(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,user_id TEXT,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,failures INTEGER NOT NULL,until_time INTEGER NOT NULL);
   PRAGMA user_version=1;`);
  if(!this.db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='must_change'))this.db.exec('ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');
  this.db.prepare("UPDATE tasks SET status='pending' WHERE status='running'").run();
  this.db.prepare("UPDATE usage SET status='interrupted',tokens=reserved WHERE status='reserved'").run();
  this.prune();this.dummyHash=passwordHash(randomBytes(24).toString('hex'));
  this.backupTimer=setInterval(()=>{try{this.prune();this.backupDaily()}catch(e){console.error('Database maintenance failed:',e.message)}},3600000);this.backupTimer.unref();
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}}
 initialized(){return !!this.db.prepare('SELECT id FROM users LIMIT 1').get()}
 audit(actor,action,target=''){this.db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?)').run(randomUUID(),actor.companyId,actor.id,action,String(target).slice(0,200),now())}
 async setup(companyName,username,name,password,validate){
  const hash=await passwordHash(password);username=this.username(username);name=this.name(name);companyName=this.name(companyName);
  let legacy;const file=path.join(this.directory,'workspace.json');if(existsSync(file)){legacy=JSON.parse(readFileSync(file,'utf8'));validate(legacy.jobs||[])}
  const companyId=randomUUID(),id=randomUUID();
  this.transaction(()=>{if(this.initialized())throw problem(409,'工作空间已初始化，请登录。');this.db.prepare('INSERT INTO companies(id,name) VALUES(?,?)').run(companyId,companyName);this.db.prepare('INSERT INTO users(id,company_id,username,name,role,enabled,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,companyId,username,name,'admin',1,hash,now());
   for(const j of legacy?.jobs||[]){const payload={...j};delete payload.revision;delete payload.ownerId;this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(j.id,companyId,id,1,JSON.stringify(payload),now())}
   for(const t of legacy?.tasks||[]){if(!this.db.prepare('SELECT id FROM jobs WHERE id=?').get(t.jobId))continue;this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run(t.id,companyId,id,t.jobId,['running','pending'].includes(t.status)?'pending':t.status,JSON.stringify({...t,actorId:id,companyId}),t.createdAt||now())}
   this.audit({companyId,id},'workspace.setup',companyId);
  });this.backupDaily(true);return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
 }
 username(value){if(typeof value!=='string'||! /^[a-z0-9][a-z0-9._@-]{2,79}$/i.test(value))throw problem(400,'登录名须为 3–80 位英文字母、数字或 . _ @ -。');return value.toLowerCase()}
 name(value){if(typeof value!=='string'||!value.trim()||value.length>100)throw problem(400,'名称须为 1–100 个字符。');return value.trim()}
 async login(username,password,address){
  const key=digest(address+':'+String(username).toLowerCase()),ipKey=digest(address),time=Date.now();
  this.db.prepare('DELETE FROM login_attempts WHERE until_time<?').run(time-86400000);
  for(const k of [key,ipKey]){const a=this.db.prepare('SELECT * FROM login_attempts WHERE key=?').get(k);if(a&&a.until_time>time&&a.failures>=(k===ipKey?30:5))throw problem(429,'登录尝试过多，请 15 分钟后重试。')}
  const u=this.db.prepare('SELECT * FROM users WHERE username=?').get(String(username).toLowerCase());
  const hash=u?.password_hash||await this.dummyHash;
  if(!await passwordMatches(password,hash)||!u?.enabled){for(const k of [key,ipKey])this.db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN until_time<? THEN 1 ELSE failures+1 END,until_time=?').run(k,time+900000,time,time+900000);throw problem(401,'登录名或密码不正确，或账号已停用。')}
  this.db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);this.db.prepare('DELETE FROM sessions WHERE expires<? OR touched<?').run(time,time-1800000);
  const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(token),u.id,csrf,time+8*3600000,time);
  const actor=publicUser(u);this.audit(actor,'auth.login');return {actor,token,csrf};
 }
 session(token){if(!token)return null;const time=Date.now(),s=this.db.prepare('SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?').get(digest(token));if(!s||!s.enabled||s.expires<time||s.touched<time-1800000)return null;this.db.prepare('UPDATE sessions SET touched=? WHERE token_hash=?').run(time,digest(token));return {actor:publicUser(s),csrf:s.csrf}}
 logout(token){if(token)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token))}
 company(actor){const c=this.db.prepare('SELECT * FROM companies WHERE id=?').get(actor.companyId);return {id:c.id,name:c.name,dailyCalls:c.daily_calls,dailyTokens:c.daily_tokens,consentVersion:c.consent_version}}
 users(actor){return this.db.prepare('SELECT * FROM users WHERE company_id=? ORDER BY created_at').all(actor.companyId).map(publicUser)}
 requireAdmin(actor){if(actor.role!=='admin')throw problem(403,'仅管理员可执行此操作。')}
 async addUser(actor,body){this.requireAdmin(actor);if(!['admin','consultant'].includes(body.role))throw problem(400,'账号角色无效。');const hash=await passwordHash(body.password),id=randomUUID();try{this.db.prepare('INSERT INTO users(id,company_id,username,name,role,enabled,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,actor.companyId,this.username(body.username),this.name(body.name),body.role,1,hash,now());this.db.prepare('UPDATE users SET must_change=1 WHERE id=?').run(id)}catch(e){if(e.message.includes('UNIQUE'))throw problem(409,'登录名已存在。');throw e}this.audit(actor,'user.create',id);return this.users(actor)}
 updateUser(actor,body){this.requireAdmin(actor);const u=this.db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(body.id,actor.companyId);if(!u)throw problem(404,'账号不存在。');if(!['admin','consultant'].includes(body.role)||typeof body.enabled!=='boolean')throw problem(400,'角色或状态无效。');if(u.id===actor.id&&(body.role!=='admin'||!body.enabled))throw problem(400,'不能停用或降级自己的管理员账号。');if(u.role==='admin'&&(!body.enabled||body.role!=='admin')&&this.db.prepare("SELECT count(*) n FROM users WHERE company_id=? AND enabled=1 AND role='admin'").get(actor.companyId).n<=1)throw problem(400,'必须保留一个启用的管理员。');this.transaction(()=>{this.db.prepare('UPDATE users SET role=?,enabled=?,name=? WHERE id=?').run(body.role,Number(body.enabled),this.name(body.name||u.name),u.id);this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);if(!body.enabled)this.db.prepare("UPDATE tasks SET status='cancelled',payload=json_set(payload,'$.message','账号已停用') WHERE owner_id=? AND status IN ('pending','running')").run(u.id);this.audit(actor,'user.update',u.id)});return this.users(actor)}
 async changePassword(actor,current,password){const u=this.db.prepare('SELECT * FROM users WHERE id=?').get(actor.id);if(!await passwordMatches(current,u.password_hash))throw problem(401,'当前密码不正确。');if(current===password)throw problem(400,'新密码不能与当前密码相同。');const hash=await passwordHash(password);this.transaction(()=>{this.db.prepare('UPDATE users SET password_hash=?,must_change=0 WHERE id=?').run(hash,actor.id);this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(actor.id);this.audit(actor,'auth.password.change')})}
 jobs(actor){const rows=actor.role==='admin'?this.db.prepare('SELECT * FROM jobs WHERE company_id=? ORDER BY updated_at').all(actor.companyId):this.db.prepare('SELECT * FROM jobs WHERE company_id=? AND owner_id=? ORDER BY updated_at').all(actor.companyId,actor.id);return rows.map(r=>({...JSON.parse(r.payload),revision:r.revision,ownerId:r.owner_id}))}
 getJob(actor,id){const r=this.db.prepare('SELECT * FROM jobs WHERE id=? AND company_id=?').get(id,actor.companyId);if(!r||(actor.role!=='admin'&&r.owner_id!==actor.id))throw problem(404,'岗位不存在或无权访问。');return {...JSON.parse(r.payload),revision:r.revision,ownerId:r.owner_id}}
 saveJobs(actor,jobs){return this.transaction(()=>{for(const j of jobs){const existing=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(j.id);if(existing&&(existing.company_id!==actor.companyId||(actor.role!=='admin'&&existing.owner_id!==actor.id)))throw problem(403,'无权修改此岗位。');const payload={...j};delete payload.revision;delete payload.ownerId;
    // Reviews are server-authored and cannot be overwritten by browser snapshots or imports.
    const current=existing?JSON.parse(existing.payload):null;for(const p of payload.people){const previous=current?.people.find(x=>x.login===p.login);delete p.review;if(previous?.review)p.review=previous.review}
    const encoded=JSON.stringify(payload);if(existing&&existing.payload===encoded)continue;
    if(existing&&existing.revision!==j.revision)throw problem(409,'岗位已被其他用户或后台任务更新，请刷新后重试。');
    if(existing)this.db.prepare('UPDATE jobs SET payload=?,revision=revision+1,updated_at=? WHERE id=?').run(encoded,now(),j.id);else this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(j.id,actor.companyId,actor.id,1,encoded,now());
    this.audit(actor,existing?'job.update':'job.create',j.id);
   }return this.jobs(actor)})}
 assign(actor,id,ownerId,revision){this.requireAdmin(actor);const job=this.getJob(actor,id),u=this.db.prepare('SELECT * FROM users WHERE id=? AND company_id=? AND enabled=1').get(ownerId,actor.companyId);if(!u)throw problem(400,'请选择启用的团队账号。');if(job.revision!==revision)throw problem(409,'岗位已更新，请刷新。');if(this.db.prepare("SELECT id FROM tasks WHERE job_id=? AND status IN ('pending','running')").get(id))throw problem(409,'请等待评估完成后分配岗位。');this.db.prepare('UPDATE jobs SET owner_id=?,revision=revision+1,updated_at=? WHERE id=?').run(ownerId,now(),id);this.audit(actor,'job.assign',id);return this.jobs(actor)}
 review(actor,body){const job=this.getJob(actor,body.jobId);if(job.revision!==body.revision)throw problem(409,'岗位已更新，请刷新后复核。');const p=job.people.find(p=>p.login===body.login);if(!p)throw problem(404,'人才结果不存在。');if(!['pending','verified','needs_info'].includes(body.status)||typeof body.note!=='string'||body.note.length>5000)throw problem(400,'复核状态或备注无效。');if(body.status==='verified'&&!core.profile(p,{...job.job,criteria:job.skills}).valid)throw problem(400,'岗位标准已变更，请更新评估后再确认复核。');p.review={status:body.status,note:body.note,reviewer:actor.name,reviewerId:actor.id,at:now(),criteriaKey:p.criteriaKey};const payload={...job};delete payload.revision;delete payload.ownerId;this.transaction(()=>{this.db.prepare('UPDATE jobs SET payload=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(payload),now(),job.id);this.audit(actor,'candidate.review',job.id+':'+p.login)});return this.getJob(actor,job.id)}
 tasks(actor){return this.db.prepare("SELECT t.* FROM tasks t JOIN jobs j ON j.id=t.job_id WHERE t.company_id=? AND (?='admin' OR j.owner_id=?) ORDER BY t.created_at").all(actor.companyId,actor.role,actor.id).map(r=>({...JSON.parse(r.payload),status:r.status}))}
 addTasks(actor,job,logins,force){return this.transaction(()=>{const active=this.db.prepare("SELECT count(*) n FROM tasks WHERE company_id=? AND status IN ('pending','running')").get(actor.companyId).n;if(active+logins.length>30)throw problem(429,'团队最多排队 30 个账号，请等待当前任务完成。');const tasks=[];for(const login of logins){const old=this.db.prepare("SELECT * FROM tasks WHERE job_id=? AND status IN ('pending','running') AND json_extract(payload,'$.login')=?").get(job.id,login);if(old){tasks.push({...JSON.parse(old.payload),status:old.status});continue}const id=randomUUID(),task={id,jobId:job.id,job:{...job.job,criteria:job.skills},login,force,status:'pending',message:'等待评估',createdAt:now(),actorId:actor.id,companyId:actor.companyId,consentVersion:this.company(actor).consentVersion};this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run(id,actor.companyId,actor.id,job.id,'pending',JSON.stringify(task),task.createdAt);tasks.push(task)}this.audit(actor,'evaluation.queue',job.id);return tasks})}
 cancel(actor,id){const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);if(!row||!this.tasks(actor).some(t=>t.id===id))throw problem(404,'任务不存在或无权访问。');if(['pending','running'].includes(row.status)){const t=JSON.parse(row.payload);t.message='已取消';this.db.prepare("UPDATE tasks SET status='cancelled',payload=? WHERE id=?").run(JSON.stringify(t),id);this.audit(actor,'evaluation.cancel',id)}return id}
 nextTask(){const r=this.db.prepare("SELECT * FROM tasks WHERE status='pending' ORDER BY created_at LIMIT 1").get();return r?{...JSON.parse(r.payload),status:r.status}:null}
 setTask(task,status,message){task.status=status;task.message=message;this.db.prepare('UPDATE tasks SET status=?,payload=? WHERE id=?').run(status,JSON.stringify(task),task.id)}
 taskStatus(id){return this.db.prepare('SELECT status FROM tasks WHERE id=?').get(id)?.status}
 complete(task,result){this.transaction(()=>{if(this.taskStatus(task.id)==='cancelled')return;const row=this.db.prepare('SELECT * FROM jobs WHERE id=? AND company_id=?').get(task.jobId,task.companyId);if(!row){this.setTask(task,'cancelled','岗位不存在');return}const j=JSON.parse(row.payload),old=j.people.find(p=>p.login.toLowerCase()===result.login.toLowerCase());if(old?.review)result.review={...old.review,status:'pending',note:old.review.note};j.people=j.people.filter(p=>p.login.toLowerCase()!==result.login.toLowerCase());j.people.push(result);this.db.prepare('UPDATE jobs SET payload=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(j),now(),task.jobId);this.setTask(task,'done','已完成');this.audit({id:task.actorId,companyId:task.companyId},'evaluation.complete',task.jobId+':'+task.login)})}
 reserve(actor,maximum){return this.transaction(()=>{const c=this.company(actor),day=now().slice(0,10),u=this.db.prepare("SELECT count(*) calls,coalesce(sum(CASE WHEN status='reserved' THEN reserved ELSE tokens END),0) tokens FROM usage WHERE company_id=? AND day=?").get(actor.companyId,day);if(u.calls>=c.dailyCalls||u.tokens+maximum>c.dailyTokens)throw problem(429,'团队当日模型预算已达到上限，请联系管理员。');const id=randomUUID();this.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)').run(id,actor.companyId,actor.id,day,maximum,0,'reserved',now());return id})}
 settle(id,tokens,status){this.db.prepare('UPDATE usage SET tokens=CASE WHEN ? IS NULL THEN reserved ELSE ? END,status=? WHERE id=?').run(tokens??null,tokens??null,status,id)}
 usage(actor){const day=now().slice(0,10),u=this.db.prepare("SELECT count(*) calls,coalesce(sum(CASE WHEN status='reserved' THEN reserved ELSE tokens END),0) tokens FROM usage WHERE company_id=? AND day=?").get(actor.companyId,day);return {day,...u,...this.company(actor)}}
 limits(actor,body){this.requireAdmin(actor);if(!Number.isInteger(body.dailyCalls)||body.dailyCalls<1||body.dailyCalls>10000||!Number.isInteger(body.dailyTokens)||body.dailyTokens<10000||body.dailyTokens>100000000)throw problem(400,'每日调用上限为 1–10000 次，token 上限为 10000–100000000。');this.db.prepare('UPDATE companies SET daily_calls=?,daily_tokens=? WHERE id=?').run(body.dailyCalls,body.dailyTokens,actor.companyId);this.audit(actor,'budget.update');return this.usage(actor)}
 audits(actor){this.requireAdmin(actor);return this.db.prepare('SELECT a.*,u.name actor_name FROM audits a LEFT JOIN users u ON u.id=a.user_id WHERE a.company_id=? ORDER BY a.created_at DESC LIMIT 100').all(actor.companyId)}
 backupDaily(force=false){if(!this.initialized())return;const dir=path.join(this.directory,'backups');mkdirSync(dir,{recursive:true});const date=now().slice(0,10),file=path.join(dir,'talentlens-'+date+(force?'-'+randomBytes(3).toString('hex'):'')+'.sqlite');if(!existsSync(file)){this.db.exec("VACUUM INTO '"+file.replace(/'/g,"''")+"'");this.lastBackup=now()}const files=readdirSync(dir).filter(f=>/^talentlens-.*\.sqlite$/.test(f)).sort();for(const f of files.slice(0,-14))unlinkSync(path.join(dir,f));return file}
 health(){return {database:this.db.prepare('PRAGMA quick_check').get().quick_check,lastBackup:this.lastBackup||null}}
 prune(){const time=Date.now();this.db.prepare('DELETE FROM sessions WHERE expires<? OR touched<?').run(time,time-1800000);this.db.prepare('DELETE FROM login_attempts WHERE until_time<?').run(time-86400000);this.db.prepare("DELETE FROM tasks WHERE status NOT IN ('pending','running') AND created_at<?").run(new Date(time-30*86400000).toISOString());this.db.prepare("DELETE FROM usage WHERE status!='reserved' AND created_at<?").run(new Date(time-90*86400000).toISOString());this.db.prepare('DELETE FROM audits WHERE created_at<?').run(new Date(time-180*86400000).toISOString())}
 close(){clearInterval(this.backupTimer);this.db.close()}
}
