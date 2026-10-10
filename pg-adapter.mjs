// Parameterized SQL bridge shared by the PostgreSQL store and integration tests.
export function postgresSQL(sql) {
 sql=sql.replace(/json_extract\(payload,'\$\.login'\)/g,"(payload::jsonb->>'login')")
  .replace(/json_set\(payload,'\$\.message','账号已停用'\)/g,"jsonb_set(payload::jsonb,'{message}','\"账号已停用\"'::jsonb)::text");
 let index=0,quoted=false,out='';
 for(let i=0;i<sql.length;i++){
  const char=sql[i];if(char==="'"){out+=char;if(quoted&&sql[i+1]==="'"){out+=sql[++i];continue}quoted=!quoted;continue}
  out+=char==='?'&&!quoted?'$'+(++index):char;
 }
 return out;
}
export class PgAdapter {
 constructor(client){this.client=client}
 exec(sql){return this.client.query(postgresSQL(sql))}
 prepare(sql){const query=async args=>{const result=await this.client.query(postgresSQL(sql),args);return result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,['n','calls','tokens','expires','touched','until_time'].includes(k)&&typeof v==='string'?Number(v):v])))};return {get:async(...args)=>(await query(args))[0],all:(...args)=>query(args),run:(...args)=>query(args)}}
}
