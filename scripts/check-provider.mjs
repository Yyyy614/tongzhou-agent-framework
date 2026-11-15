const base=process.env.DEEPSEEK_BASE_URL??'https://api.deepseek.com';
const apiKey=process.env.DEEPSEEK_API_KEY;
if(!apiKey){console.log(JSON.stringify({configured:false}));process.exit(2);}
try {
 const response=await fetch(base.replace(/\/$/u,'')+'/models',{headers:{Authorization:'Bearer '+apiKey,'x-api-key':apiKey},signal:AbortSignal.timeout(15000)});
 const body=await response.json().catch(()=>null);
 console.log(JSON.stringify({configured:true,status:response.status,models:response.ok?body?.data?.map(x=>x.id):undefined,errorType:response.ok?undefined:body?.error?.type}));
 if(!response.ok)process.exit(1);
}catch(error){console.log(JSON.stringify({configured:true,error:error instanceof Error?error.message:'network error'}));process.exit(1);}
