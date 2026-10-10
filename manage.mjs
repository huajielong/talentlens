import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,copyFileSync,renameSync,unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {passwordHash} from './client-store.mjs';
const directory=path.resolve(process.env.TALENTLENS_DATA_DIR||fileURLToPath(new URL('./data',import.meta.url)));
const file=path.join(directory,'talentlens.sqlite'),command=process.argv[2];
if(command==='setup-token'){console.log(randomBytes(32).toString('hex'));process.exit(0)}
if(!['backup','check','restore','reset-password'].includes(command))throw Error('用法：node manage.mjs backup | check <备份文件> | restore <备份文件> --server-stopped | reset-password <登录名>');
if(command==='reset-password'){
 if(!process.stdin.isTTY)throw Error('密码重置必须由维护人员在交互终端操作。');
 if(!existsSync(file))throw Error('数据库不存在。');const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000');const user=db.prepare('SELECT * FROM users WHERE username=?').get(String(process.argv[3]||'').toLowerCase());if(!user){db.close();throw Error('账号不存在。')}
 const muted=new Writable({write(chunk,encoding,callback){callback()}}),prompt=createInterface({input:process.stdin,output:muted,terminal:true});let password;
 try{process.stdout.write('新的临时密码（至少 12 位，输入不回显）：');password=await prompt.question('');process.stdout.write('\n再次输入：');const confirmation=await prompt.question('');process.stdout.write('\n');if(password!==confirmation)throw Error('两次密码不一致。')}finally{prompt.close()}
 const hash=await passwordHash(password);password='';db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE users SET password_hash=?,must_change=1 WHERE id=?').run(hash,user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?)').run(randomBytes(16).toString('hex'),user.company_id,null,'auth.password.reset',user.id,new Date().toISOString());db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}finally{db.close()}console.log('密码已重置，旧会话已撤销。员工下次登录必须修改临时密码。');
}else if(command==='restore'){
 if(!process.argv.includes('--server-stopped'))throw Error('请先停止服务，再使用 --server-stopped 恢复。');
 const source=path.resolve(process.argv[3]||'');if(source===file||!existsSync(source))throw Error('请选择现有的独立备份文件。');
 const check=new DatabaseSync(source,{readOnly:true});if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('备份校验失败。');for(const table of ['companies','users','sessions','jobs','tasks','usage','audits'])check.prepare('SELECT count(*) FROM '+table).get();check.close();
 mkdirSync(directory,{recursive:true});const temporary=file+'.restore-'+randomBytes(4).toString('hex');copyFileSync(source,temporary);const restored=new DatabaseSync(temporary);restored.exec("DELETE FROM sessions; UPDATE tasks SET status='pending' WHERE status='running'; UPDATE usage SET tokens=reserved,status='interrupted' WHERE status='reserved';");restored.close();
 if(existsSync(file)){const old=new DatabaseSync(file);old.exec('PRAGMA wal_checkpoint(TRUNCATE)');old.close();renameSync(file,file+'.before-restore-'+Date.now())}
 for(const suffix of ['-wal','-shm'])if(existsSync(file+suffix))unlinkSync(file+suffix);renameSync(temporary,file);console.log('恢复完成。原数据库已保留，所有用户需要重新登录。');
}else{
 const source=command==='check'?path.resolve(process.argv[3]||file):file;if(!existsSync(source))throw Error('数据库文件不存在。');const db=new DatabaseSync(source,{readOnly:command==='check'});db.exec('PRAGMA busy_timeout=5000');if(command==='check')console.log('Database integrity:',db.prepare('PRAGMA quick_check').get().quick_check);else{const dir=path.join(directory,'backups');mkdirSync(dir,{recursive:true});const target=path.join(dir,'manual-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');db.exec("VACUUM INTO '"+target.replace(/'/g,"''")+"'");console.log(target)}db.close();
}
