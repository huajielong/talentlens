(function(root){
 // Legacy request decoding could expand replacement characters at chunk boundaries.
 const stable=value=>JSON.stringify(value,(k,v)=>typeof v==='string'?v.normalize('NFC').replace(/\ufffd+/g,'\ufffd'):v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
 const key=job=>stable({jd:job.jd,criteria:(job.criteria||[]).map(({weight,...c})=>c).sort((a,b)=>a.id.localeCompare(b.id))});
 const normalize=value=>{try{return key(JSON.parse(value))}catch{return value}};
 const fresh=p=>!!p.capturedAt&&Date.now()-Date.parse(p.capturedAt)<7*86400000;
 function profile(p,job){const valid=normalize(p.criteriaKey)===key(job);const skills=(job.criteria||[]).map(s=>{const a=valid?p.assessment?.assessments.find(a=>a.criterionId===s.id):null;return {...s,assessment:a,value:!s.observable||a?.score==null?null:a.score/100,e:(a?.evidenceIds||[]).map(id=>p.sources?.find(x=>x.id===id)).filter(Boolean).map(x=>({repo:{name:x.label||x.id,html_url:x.url},kind:x.kind||'项目资料',source:x}))}});const eligible=skills.filter(s=>s.observable),known=eligible.filter(s=>s.value!==null),total=eligible.reduce((n,s)=>n+s.weight,0),covered=known.reduce((n,s)=>n+s.weight,0);return {skills,valid,score:covered?Math.round(known.reduce((n,s)=>n+s.weight*s.value,0)/covered*100):null,coverage:total?Math.round(covered/total*100):0,pending:skills.filter(s=>s.value===null).length,fresh:fresh(p)}}
 const api={key,normalize,profile,fresh};if(typeof module!=='undefined')module.exports=api;else root.TalentCore=api;
})(globalThis);
