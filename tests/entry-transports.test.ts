import{test,expect}from'vitest';
import{normalize}from'../connectors/im-bridge/transports.mjs';
import{connect,acceptFailure,shouldAcknowledge}from'../connectors/im-bridge/transports.mjs';
import{createRequire}from'node:module';

test('official platform message formats normalize to identity-bound text without trusting nicknames',()=>{
    const ding=normalize('dingtalk',{headers:{messageId:'frame'},data:JSON.stringify({msgtype:'text',msgId:'one',senderCorpId:'corp',senderStaffId:'user',senderNick:'admin',conversationId:'conversation',conversationType:'1',text:{content:'hello'},sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?session=fixture',sessionWebhookExpiredTime:Date.now()+60000})});
    expect(ding).toMatchObject({externalUserId:'corp:user',text:'hello',isGroup:false});expect(ding).not.toHaveProperty('principalId');
    const lark=normalize('feishu',{sender:{sender_type:'user',tenant_key:'tenant',sender_id:{open_id:'user'}},message:{message_id:'two',chat_id:'chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'hello'})}});
    expect(lark).toMatchObject({externalUserId:'tenant:user',isGroup:false,text:'hello'});
    const wecom=normalize('wecom',{headers:{req_id:'request'},body:{msgid:'three',msgtype:'text',chattype:'single',from:{userid:'user'},text:{content:'hello'}}});expect(wecom).toMatchObject({externalUserId:'user',conversationId:'user',text:'hello',isGroup:false});
    expect(normalize('feishu',{sender:{sender_type:'app'},message:{}})).toBeNull();expect(normalize('wecom',{body:{msgtype:'image'}})).toBeNull();
});

test('a storage failure or admission timeout requests redelivery while an explicit identity denial can be acknowledged',()=>{
    expect(shouldAcknowledge(acceptFailure(Error('database offline')))).toBe(false);
    expect(shouldAcknowledge(acceptFailure({code:'RECEIVE_TIMEOUT'}))).toBe(false);
    expect(shouldAcknowledge(acceptFailure({code:'PERMISSION_DENIED'}))).toBe(true);
    expect(shouldAcknowledge({accepted:false,reason:'UNBOUND_IDENTITY'})).toBe(true);
    expect(shouldAcknowledge({accepted:true})).toBe(true);
});

test('the official WeCom SDK authenticates, receives a frame and confirms the final stream reply through its isolated process',async()=>{
    const require=createRequire(new URL('../connectors/im-bridge/package.json',import.meta.url)),{WebSocketServer}=require('ws');const server=new WebSocketServer({host:'127.0.0.1',port:0}),incoming:any[]=[],sent:any[]=[];let authenticated=false;
    server.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{const frame=JSON.parse(bytes.toString());if(frame.cmd==='aibot_subscribe'){authenticated=frame.body.bot_id==='fixture-bot'&&frame.body.secret==='fixture-secret';socket.send(JSON.stringify({cmd:frame.cmd,headers:frame.headers,errcode:0,errmsg:'ok'}));setTimeout(()=>socket.send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'incoming'},body:{msgid:'one',aibotid:'fixture-bot',chattype:'single',from:{userid:'employee'},msgtype:'text',text:{content:'generic task'}}})),30);}if(frame.cmd==='aibot_respond_msg'){sent.push(frame);socket.send(JSON.stringify({cmd:frame.cmd,headers:frame.headers,errcode:0,errmsg:'ok'}));}}));
    await new Promise<void>(r=>server.once('listening',r));const transport=await connect('wecom',{botId:'fixture-bot',secret:'fixture-secret'},{receive:async(message:any)=>{incoming.push(message);return{accepted:true};},health:()=>{}},{wecomUrl:'ws://127.0.0.1:'+server.address().port});
    try{await expect.poll(()=>incoming.length,{timeout:10000}).toBe(1);expect(authenticated).toBe(true);await transport.send(incoming[0].reply,'confirmed result');expect(sent.some((frame:any)=>frame.body.stream?.finish===true&&frame.body.stream?.content==='confirmed result')).toBe(true);}finally{await transport.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(r=>server.close(r));}
},20000);
