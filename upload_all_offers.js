const axios=require('axios'),fs=require('fs'),FormData=require('form-data');
const B=process.env.MIRAKL_BASE_URL,K=process.env.MIRAKL_API_KEY;
(async()=>{
  console.log('Uploading full offers file...');
  const form=new FormData();
  form.append('file',fs.createReadStream('output/2026-03-26T06-49-11-offers.csv'),{filename:'offers.csv',contentType:'text/csv'});
  const r=await axios.post(B+'/api/offers/imports',form,{headers:{...form.getHeaders(),Authorization:K},params:{import_mode:'NORMAL'},timeout:300000});
  const importId=r.data.import_id;
  console.log('OF01 import ID:',importId);
  
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,15000));
    const s=await axios.get(B+'/api/offers/imports/'+importId,{headers:{Authorization:K},timeout:30000});
    const d=s.data;
    console.log(`[${i+1}] status=${d.status} read=${d.lines_read} ok=${d.lines_in_success} err=${d.lines_in_error} pending=${d.lines_in_pending}`);
    if(d.status==='COMPLETE'||d.status==='FAILED'){
      if(d.lines_in_error>0){
        const e=await axios.get(B+'/api/offers/imports/'+importId+'/error_report',{headers:{Authorization:K},timeout:30000,responseType:'text'});
        const lines=e.data.split('\n');
        const h=lines[0].split(';').map(x=>x.replace(/"/g,''));
        const ei=h.findIndex(x=>x.toLowerCase().includes('error-message'));
        const counts={};
        for(let j=1;j<lines.length;j++){if(!lines[j].trim())continue;const c=lines[j].split(';').map(x=>x.replace(/^"|"$/g,''));counts[c[ei]]=(counts[c[ei]]||0)+1}
        console.log('Error breakdown:');
        Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([m,c])=>console.log('  ['+c+'x] '+m.substring(0,150)));
      }
      break;
    }
  }
  
  const o=await axios.get(B+'/api/offers',{headers:{Authorization:K},params:{max:5},timeout:30000});
  console.log('\nTotal live offers:',o.data.total_count);
  if(o.data.offers?.length>0){
    o.data.offers.forEach(x=>console.log('  SKU:',x.shop_sku,'price:',x.price,'qty:',x.quantity,'active:',x.active));
  }
})().catch(e=>console.error('FATAL:',e.response?.data||e.message));
