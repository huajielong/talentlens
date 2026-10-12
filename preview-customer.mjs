// Disposable browser QA workspace. No real credentials, customer data or model calls.
import {mkdtempSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer,validateWorkspace} from './server.mjs';
import core from './dist/core.js';
const directory=mkdtempSync(path.join(os.tmpdir(),'talentlens-preview-'));
const criterion={id:'react',name:'React 工程能力',weight:3,requirement:'React',sourceQuote:'React',observable:true,rubric:{zero:'明确反向证据',partial:'相关项目线索',strong:'可验证个人贡献'},verificationQuestion:'请介绍个人职责与项目成果。'};
const job={title:'前端研发工程师',summary:'React',jd:'招聘 React 工程师，重视可验证的个人贡献。',criteria:[criterion]};
const person={login:'example',name:'测试人才',accountType:'User',criteriaKey:core.key(job),capturedAt:new Date().toISOString(),time:new Date().toLocaleString('zh-CN'),model:'模拟模型',repos:[],sources:[{id:'repo-0',label:'React 项目',kind:'项目技术栈',url:'https://github.com/example/react',text:'React'}],assessment:{summary:'仅供界面验证的虚构人才，不是招聘判断。',assessments:[{criterionId:'react',score:70,confidence:'low',reason:'项目线索待核对个人贡献',evidenceIds:['repo-0'],verificationQuestion:'个人贡献？'}]}};
writeFileSync(path.join(directory,'workspace.json'),JSON.stringify({version:3,jobs:[{id:'qa-job',title:job.title,jd:job.jd,skills:job.criteria,job,people:[person],tracked:[],accounts:'https://github.com/example'}],tasks:[]}));
const server=createServer({TALENTLENS_DATA_DIR:directory,DEEPSEEK_API_KEY:'fixture',DEEPSEEK_MODEL:'QA 模拟模型'},async()=>{throw Error('界面测试环境不调用外部服务')});
await server.customerStore.setup('界面验收 · 虚构数据','qa-admin','测试管理员','qa-fixture-password-123',validateWorkspace);
server.listen(4190,'127.0.0.1',()=>console.log('Browser QA http://127.0.0.1:4190/; disposable test-only account qa-admin'));
