import {model,jobSchema,validateJob,evaluate,llmConfig} from './server.mjs';
const config=llmConfig(process.env);console.log('Provider:',config.provider,'Model:',config.model);
const jd='招聘前端工程师：熟悉 TypeScript 和 React，有公开项目经验。';
try{
 const job=await model(process.env,fetch,'你是岗位需求分析助手。只返回 JSON。从 JD 提取 2 项技能评估标准，给出唯一 id、name、weight(1-5)、requirement、sourceQuote（必须为 JD 连续原文）、observable、rubric 的 zero/partial/strong、verificationQuestion。输出中文。',{jd},jobSchema,'job_rubric');validateJob(job,jd);console.log('LIVE JD PARSE PASS:',job.criteria.map(c=>c.name).join(', '));
 const person=await evaluate('octocat',{...job,jd},process.env);console.log('LIVE GITHUB EVALUATION PASS:',person.login,'criteria:',person.assessment.assessments.length,'sources:',person.sources.length);
}catch(e){console.error('LIVE CHECK FAILED:',e.message);process.exitCode=1}
