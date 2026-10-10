import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
const files=['cloud-server.mjs','pg-store.mjs','pg-adapter.mjs','model-services.mjs','netlify/runtime.mjs',...readdirSync('netlify/functions').map(f=>'netlify/functions/'+f),...readdirSync('dist').filter(f=>f.endsWith('.js')).map(f=>'dist/'+f)];
for(const file of files)execFileSync(process.execPath,['--check',file]);
console.log('Cloud functions and browser assets passed syntax checks.');
