import{randomUUID}from'node:crypto';
import{normalize,acceptFailure,shouldAcknowledge}from'./transports.mjs';
let sender,stop=async()=>{};const inputs=new Map();
const health=state=>process.send?.({type:'health',state});
const logger={trace(){},debug(){},info(){},warn(){},error(){health('connection_error');}};
function receive(provider,frame){const message=normalize(provider,frame);if(!message)return Promise.resolve({accepted:false});return new Promise(resolve=>{const id=randomUUID(),timer=setTimeout(()=>{inputs.delete(id);resolve(acceptFailure({code:'RECEIVE_TIMEOUT'}));},2500);inputs.set(id,{resolve,timer});process.send?.({type:'input',id,message});});}
async function start(provider,credentials,options){
    health('connecting');
    if(provider==='wecom'){
        const sdk=await import('@wecom/aibot-node-sdk'),client=new sdk.WSClient({...credentials,logger,maxReconnectAttempts:-1,...(options.wecomUrl?{wsUrl:options.wecomUrl}:{})});
        client.on('authenticated',()=>health('connected'));client.on('disconnected',()=>health('disconnected'));client.on('error',()=>health('connection_error'));
        client.on('message.text',async frame=>{const result=await receive(provider,frame);if(result.accepted&&!result.duplicate){const message=normalize(provider,frame);try{await client.replyStream(frame,message.reply.streamId,result.bindingPending?'请返回公司工作台确认绑定。':'已收到。发送 /status 可查看工作编号和状态。',!!result.bindingPending);}catch{health('reply_error');}}});
        sender=async(reply,text)=>{const receipt=await client.replyStream({headers:{req_id:reply.reqId}},reply.streamId,text,true);if(receipt?.errcode!==0)throw Error('DELIVERY_UNKNOWN');};stop=async()=>client.disconnect();client.connect();return;
    }
    if(provider==='dingtalk'){
        const sdk=await import('dingtalk-stream'),client=new sdk.DWClient({...credentials,debug:false,keepAlive:true,autoReconnect:true,subscriptions:[{type:'CALLBACK',topic:'/v1.0/im/bot/messages/get'}]});
        client.on('error',()=>health('connection_error'));client.registerCallbackListener('/v1.0/im/bot/messages/get',async frame=>{try{const result=await receive(provider,frame);if(shouldAcknowledge(result))client.socketCallBackResponse(frame.headers.messageId,{});else health('receive_error');}catch{health('receive_error');}});
        sender=async(reply,text)=>{const url=new URL(reply.url);if(url.protocol!=='https:'||url.hostname!=='oapi.dingtalk.com'||url.port&&url.port!=='443'||url.username||url.password||url.pathname!=='/robot/sendBySession'||Number(reply.expiresAt)<=Date.now())throw Error('INVALID_REPLY_DESTINATION');const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({msgtype:'text',text:{content:text}}),signal:AbortSignal.timeout(15000)});const result=await response.json();if(!response.ok||result.errcode!==0)throw Error('DELIVERY_UNKNOWN');};
        stop=async()=>client.disconnect();void client.connect().then(()=>health('connected')).catch(()=>health('connection_error'));return;
    }
    if(provider==='feishu'){
        const sdk=await import('@larksuiteoapi/node-sdk'),client=new sdk.Client({...credentials,logger}),ws=new sdk.WSClient({...credentials,logger});
        const eventDispatcher=new sdk.EventDispatcher({}).register({'im.message.receive_v1':async frame=>{const result=await receive(provider,frame);if(!shouldAcknowledge(result))throw Error('DURABLE_ACCEPT_PENDING');}});
        sender=async(reply,text)=>{const response=await client.im.message.reply({path:{message_id:reply.messageId},data:{msg_type:'text',content:JSON.stringify({text}),uuid:reply.uuid}});if(response?.code!==0)throw Error('DELIVERY_UNKNOWN');};
        stop=async()=>ws.close({force:true});void ws.start({eventDispatcher}).then(()=>health('connected')).catch(()=>health('connection_error'));return;
    }
    throw Error('UNSUPPORTED_PROVIDER');
}
process.on('message',async message=>{
    if(message?.type==='start'){try{await start(message.provider,message.credentials,message.options);}catch{health('connection_error');}}
    if(message?.type==='accepted'){const pending=inputs.get(message.id);if(pending){clearTimeout(pending.timer);inputs.delete(message.id);pending.resolve(message.result);}}
    if(message?.type==='send'){try{if(!sender)throw Error('NOT_CONNECTED');await sender(message.reply,message.text);process.send?.({type:'result',id:message.id,ok:true});}catch{process.send?.({type:'result',id:message.id,ok:false});}}
    if(message?.type==='close'){await stop().catch(()=>{});process.exit(0);}
});
process.on('disconnect',()=>{void stop().finally(()=>process.exit(0));});process.send?.({type:'ready'});
