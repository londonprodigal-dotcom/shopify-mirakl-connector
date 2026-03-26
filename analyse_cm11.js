const axios=require('axios');
const B=process.env.MIRAKL_BASE_URL,K=process.env.MIRAKL_API_KEY;
(async()=>{
  // Paginate through all products
  let offset=0, live=0, notLive=0, total=0;
  const errorCounts={};
  
  while(true){
    const r=await axios.get(B+'/api/mcm/products/sources/status/export',{
      headers:{Authorization:K},
      params:{offset,max:100},
      timeout:60000
    });
    const items=Object.values(r.data).filter(x=>typeof x==='object'&&x!==null&&'status' in x);
    if(items.length===0) break;
    
    for(const p of items){
      total++;
      if(p.status==='LIVE') live++;
      else{
        notLive++;
        if(p.errors?.length>0){
          const detail=p.errors[0].rejection_details?.message||p.errors[0].message||'unknown';
          // Extract first error type
          const key=detail.substring(0,120);
          errorCounts[key]=(errorCounts[key]||0)+1;
        }
      }
    }
    offset+=100;
    if(items.length<100) break;
  }
  
  console.log(`Products: ${total} total | ${live} LIVE | ${notLive} NOT_LIVE`);
  console.log(`\nRejection breakdown (${notLive} products):`);
  Object.entries(errorCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([m,c])=>console.log(`  [${c}x] ${m}`));
})().catch(e=>console.error('Error:',e.response?.status,e.response?.data?.message||e.message));
