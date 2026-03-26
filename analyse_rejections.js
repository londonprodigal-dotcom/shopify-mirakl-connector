const axios=require('axios');
const B=process.env.MIRAKL_BASE_URL,K=process.env.MIRAKL_API_KEY;
(async()=>{
  // Check integration status of all recent imports
  const ids=[4713700,4713343,4713154,4703907];
  for(const id of ids){
    try{
      const r=await axios.get(B+'/api/products/imports/'+id,{headers:{Authorization:K},timeout:30000});
      const d=r.data;
      const i=d.integration_details||{};
      console.log(id+' '+d.import_status+' synced='+(i.products_successfully_synchronized??'?')+' rejected='+(i.rejected_products??'?'));
    }catch(e){console.log(id+' error:'+e.message)}
  }
  
  // Find the latest COMPLETE import with integration details
  for(const id of ids){
    const r=await axios.get(B+'/api/products/imports/'+id,{headers:{Authorization:K},timeout:30000});
    if(r.data.import_status!=='COMPLETE') continue;
    if(!r.data.has_error_report) continue;
    
    console.log('\n=== Error report for '+id+' ===');
    const err=await axios.get(B+'/api/products/imports/'+id+'/error_report',{headers:{Authorization:K},timeout:60000,responseType:'text'});
    const lines=err.data.split('\n');
    const h=lines[0].split(';').map(x=>x.replace(/"/g,''));
    const errIdx=h.findIndex(x=>x.toLowerCase()==='errors');
    const titleIdx=h.findIndex(x=>x.toLowerCase().includes('product_title'));
    
    console.log('Total error lines:',(lines.length-1));
    
    const counts={};
    const samples={};
    for(let j=1;j<lines.length;j++){
      if(!lines[j].trim())continue;
      const c=lines[j].split(';').map(x=>x.replace(/^"|"$/g,''));
      const msg=c[errIdx]||'?';
      const title=c[titleIdx]||'?';
      // Group by error type prefix
      const key=msg.substring(0,120);
      counts[key]=(counts[key]||0)+1;
      if(!samples[key]) samples[key]=title.substring(0,50);
    }
    console.log('\nRejection breakdown:');
    Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([m,c])=>{
      console.log('  ['+c+'x] '+m);
      console.log('    example: '+samples[m]);
    });
    break; // only need the latest
  }
})().catch(e=>console.error('FATAL:',e.response?.data||e.message));
