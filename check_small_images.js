const axios=require('axios');
const B=process.env.MIRAKL_BASE_URL,K=process.env.MIRAKL_API_KEY;
(async()=>{
  const err=await axios.get(B+'/api/products/imports/4703907/error_report',{headers:{Authorization:K},timeout:60000,responseType:'text'});
  const lines=err.data.split('\n');
  const h=lines[0].split(';').map(x=>x.replace(/"/g,''));
  const errIdx=h.findIndex(x=>x.toLowerCase()==='errors');
  const titleIdx=h.findIndex(x=>x.toLowerCase().includes('product_title'));
  
  // Find image columns
  const imgCols=[];
  h.forEach((col,i)=>{if(col.toLowerCase().includes('image'))imgCols.push({name:col,idx:i})});
  
  // Get rows with small image errors
  const smallImgRows=[];
  for(let j=1;j<lines.length;j++){
    if(!lines[j].trim())continue;
    const c=lines[j].split(';').map(x=>x.replace(/^"|"$/g,''));
    const msg=c[errIdx]||'';
    if(msg.includes('188px')||msg.includes('474px')||msg.includes('447px')||msg.includes('488px')||msg.includes('498px')){
      const imgs={};
      imgCols.forEach(ic=>{if(c[ic.idx])imgs[ic.name]=c[ic.idx].substring(0,120)});
      smallImgRows.push({title:c[titleIdx],error:msg.substring(0,150),images:imgs});
    }
  }
  console.log('Products with very small images:',smallImgRows.length);
  smallImgRows.slice(0,5).forEach(r=>{
    console.log('\n'+r.title);
    console.log('  Error: '+r.error);
    Object.entries(r.images).forEach(([k,v])=>{
      if(v&&v!=='')console.log('  '+k+': '+v);
    });
  });
})().catch(e=>console.error(e.response?.data||e.message));
