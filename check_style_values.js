const axios=require('axios');
const B=process.env.MIRAKL_BASE_URL,K=process.env.MIRAKL_API_KEY;
(async()=>{
  const lists=['style_womensdresses','style_womenstops','style_womensjacketscoats','style_womenstrousers','style_skirts'];
  for(const code of lists){
    const r=await axios.get(B+'/api/values_lists',{headers:{Authorization:K},params:{code},timeout:30000});
    const vals=r.data.values_lists?.[0]?.values||[];
    console.log('\n=== '+code+' ('+vals.length+' values) ===');
    vals.forEach(v=>console.log('  '+v.code));
  }
})().catch(e=>console.error(e.response?.data||e.message));
