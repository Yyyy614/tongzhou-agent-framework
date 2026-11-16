import{createHash,randomUUID}from'node:crypto';
import{fork}from'node:child_process';
import{fileURLToPath}from'node:url';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const acceptFailure=error=>({accepted:false,retry:!['PERMISSION_DENIED','CANCELLED','CONFLICT','INVALID_INPUT','NOT_FOUND'].includes(error?.code)});
export const shouldAcknowledge=result=>result?.retry!==true;
export function normalize(provider,frame){
    try{
        if(provider==='dingtalk'){
            const data=typeof frame.data==='string'?JSON.parse(frame.data):frame.data;if(data?.msgtype!=='text'||!data.senderStaffId)return null;
            return{externalUserId:(data.senderCorpId??data.chatbotCorpId??'')+':'+data.senderStaffId,conversationId:data.conversationId,messageId:data.msgId,text:data.text.content.trim(),isGroup:data.conversationType!=='1',reply:{url:data.sessionWebhook,expiresAt:data.sessionWebhookExpiredTime}};
        }
        if(provider==='feishu'){
            const data=frame.event??frame,message=data.message,sender=data.sender;if(message?.message_type!=='text'||sender?.sender_type!=='user'||!sender.sender_id?.open_id)return null;
            return{externalUserId:(sender.tenant_key??frame.header?.tenant_key??'')+':'+sender.sender_id.open_id,conversationId:message.chat_id,messageId:message.message_id,...(message.thread_id?{topicId:message.thread_id}:{}),...((message.parent_id??message.root_id)?{replyToMessageId:message.parent_id??message.root_id}:{}),text:JSON.parse(message.content).text.trim(),isGroup:message.chat_type!=='p2p',reply:{messageId:message.message_id,uuid:digest(message.message_id).slice(0,32)}};
        }
        if(provider==='wecom'){
            const data=frame.body;if(data?.msgtype!=='text'||!data.from?.userid||!frame.headers?.req_id)return null;
            return{externalUserId:data.from.userid,conversationId:data.chatid??data.from.userid,messageId:data.msgid,text:data.text.content.trim(),isGroup:data.chattype!=='single',reply:{reqId:frame.headers.req_id,streamId:digest(data.msgid).slice(0,32)}};
        }
    }catch{return null;}return null;
}
/** Vendor SDKs run in an isolated process; their raw HTTP error logs cannot expose credentials. */
export async function connect(provider,credentials,hooks,options={}){
    let child,closed=false,restart;const pending=new Map();
    const environment=Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const start=()=>{
        if(closed)return;child=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[],{windowsHide:true,env:environment,stdio:['ignore','ignore','ignore','ipc']});
        const owner=child,send=message=>{if(owner.connected)try{owner.send(message,()=>{});}catch{}};
        child.on('message',async message=>{
            if(message?.type==='ready')send({type:'start',provider,credentials,options});
            if(message?.type==='health')hooks.health(message.state);
            if(message?.type==='input'){try{const result=await hooks.receive(message.message);send({type:'accepted',id:message.id,result});}catch(error){send({type:'accepted',id:message.id,result:acceptFailure(error)});}}
            if(message?.type==='result'){const operation=pending.get(message.id);if(operation){pending.delete(message.id);clearTimeout(operation.timer);message.ok?operation.resolve():operation.reject(Error('DELIVERY_UNKNOWN'));}}
        });
        child.on('error',()=>hooks.health('connection_error'));
        child.on('exit',()=>{for(const operation of pending.values()){clearTimeout(operation.timer);operation.reject(Error('DELIVERY_UNKNOWN'));}pending.clear();if(!closed){hooks.health('connection_error');restart=setTimeout(start,5000).unref();}});
    };start();
    return{send(reply,text){return new Promise((resolve,reject)=>{if(!child?.connected)return reject(Error('TRANSPORT_UNAVAILABLE'));const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('DELIVERY_UNKNOWN'));},20000);pending.set(id,{resolve,reject,timer});child.send({type:'send',id,reply,text},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(Error('DELIVERY_UNKNOWN'));}});});},async close(){closed=true;clearTimeout(restart);for(const operation of pending.values()){clearTimeout(operation.timer);operation.reject(Error('TRANSPORT_CLOSED'));}pending.clear();if(child?.connected){child.send({type:'close'});await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},1000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}}};
}
