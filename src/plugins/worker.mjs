import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
const handlers=new Map();const pending=new Map();let next=0;let module;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
function host(method,params){const id='worker-'+(++next);return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({jsonrpc:'2.0',id,method,params});});}
createInterface({input:process.stdin}).on('line',async line=>{
 let request;try{request=JSON.parse(line);}catch{return;}
 if(!request.method){const p=pending.get(request.id);if(p){pending.delete(request.id);if(request.error)p.reject(Object.assign(new Error(request.error.message),{code:request.error.data?.code}));else p.resolve(request.result);}return;}
 try{
  let result;
  if(request.method==='plugin.initialize'){
   module=await import(pathToFileURL(request.params.entry).href);
   await module.apply({config:request.params.config??{},tools:{register(id,handler){if(handlers.has(id))throw new Error('Duplicate tool');handlers.set(id,handler);}}});
   result={protocol:'1.0',tools:[...handlers.keys()]};
  }else if(request.method==='plugin.health'){result={status:'ready'};
  }else if(request.method==='capability.describe'){result={protocol:'1.0',tools:[...handlers.keys()]};
  }else if(request.method==='tool.invoke'){
   const {invocationId,toolId,input}=request.params;const handler=handlers.get(toolId);if(!handler)throw new Error('Tool not registered');
   const services={memory:{read:ref=>host('memory.read',{invocationId,ref}),proposeWrite:entry=>host('memory.write',{invocationId,entry})},reports:{record:record=>host('report.record',{invocationId,record})}};
   Object.assign(services,{team:{list:()=>host('team.list',{invocationId})},work:{dispatch:input=>host('work.dispatch',{invocationId,input}),list:()=>host('work.list',{invocationId}),read:id=>host('work.read',{invocationId,id})},reminders:{schedule:input=>host('reminder.create',{invocationId,input}),list:()=>host('reminder.list',{invocationId})},inbox:{list:()=>host('inbox.list',{invocationId})},events:{publish:input=>host('event.publish',{invocationId,input})}});
   services.connections={catalog:()=>host('connection.catalog',{invocationId}),describe:id=>host('connection.catalog',{invocationId,id})};
   result=await handler(input,{runRef:request.params.runId,services,signal:new AbortController().signal});
  }else if(request.method==='plugin.shutdown'){await module?.shutdown?.();result={closed:true};}
  else throw new Error('Unknown worker method');
  send({jsonrpc:'2.0',id:request.id,result});
 }catch(error){send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:error instanceof Error?error.message:'Plugin failed',data:{code:error?.code??'PLUGIN_ERROR'}}});}
});
