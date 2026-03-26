const axios=require('axios');
const B=process.env.MIRAKL_BASE_URL,K=process.env.MIRAKL_API_KEY;
(async()=>{
  const err=await axios.get(B+'/api/products/imports/4713873/transformation_error_report',{headers:{Authorization:K},timeout:60000,responseType:'text'});
  const lines=err.data.split('\n');
  const h=lines[0].split(';').map(x=>x.replace(/"/g,''));
  const errIdx=h.findIndex(x=>x.toLowerCase()==='errors');
  const counts={};
  for(let j=1;j<lines.length;j++){
    if(!lines[j].trim())continue;
    const c=lines[j].split(';').map(x=>x.replace(/^"|"$/g,''));
    const msg=c[errIdx]||'?';
    counts[msg]=(counts[msg]||0)+1;
  }
  console.log('Error breakdown ('+Object.values(counts).reduce((a,b)=>a+b,0)+' total):');
  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([m,c])=>console.log('  ['+c+'x] '+m.substring(0,200)));
})().catch(e=>console.error(e.response?.data||e.message));
