const axios=require('axios'),fs=require('fs'),FormData=require('form-data');
const B=process.env.MIRAKL_BASE_URL,K=process.env.MIRAKL_API_KEY;
(async()=>{
  const form=new FormData();
  form.append('file',fs.createReadStream('output/test-offers.csv'),{filename:'o.csv',contentType:'text/csv'});
  const r=await axios.post(B+'/api/offers/imports',form,{headers:{...form.getHeaders(),Authorization:K},params:{import_mode:'NORMAL'},timeout:300000});
  console.log('Import ID:',r.data.import_id);
  for(let i=0;i<12;i++){
    await new Promise(r=>setTimeout(r,10000));
    const s=await axios.get(B+'/api/offers/imports/'+r.data.import_id,{headers:{Authorization:K},timeout:30000});
    const d=s.data;
    console.log('status='+d.status+' read='+d.lines_read+' ok='+d.lines_in_success+' err='+d.lines_in_error);
    if(d.status==='COMPLETE'||d.status==='FAILED'){
      if(d.lines_in_error>0){
        const e=await axios.get(B+'/api/offers/imports/'+r.data.import_id+'/error_report',{headers:{Authorization:K},timeout:30000,responseType:'text'});
        const lines=e.data.split('\n');
        for(let j=0;j<Math.min(lines.length,5);j++) console.log(lines[j].substring(0,200));
      }
      break;
    }
  }
  const o=await axios.get(B+'/api/offers',{headers:{Authorization:K},params:{max:5},timeout:30000});
  console.log('Live offers:',o.data.total_count);
})().catch(e=>console.error(e.response?.data||e.message));
