import type{EntryConnections,EntryMessage}from'./entry-connections.js';
import{fail}from'./errors.js';
const labels:Record<string,string>={queued:'排队中',running:'执行中',stop_requested:'正在停止',stopped:'已停止',waiting:'等待人工或依赖',waiting_review:'等待人工核对',completed:'已核对完成',changes_requested:'需要调整',needs_attention:'需要处理',reconciliation_required:'结果待核实'};
const errors:Record<string,string>={INVALID_INPUT:'命令格式不正确。示例：/stop W-000001 原因；/resume W-000001 新要求。',PERMISSION_DENIED:'当前账号没有这项工作操作权限。',CONFLICT:'工作或配置已变化，请先查询状态，再明确发送新指令。',RESULT_UNKNOWN:'执行结果待核实，请到公司工作中心核对，不要重复执行。',NOT_FOUND:'未找到可访问的工作。',BUDGET_EXCEEDED:'当前用量或任务额度已达到限制。'};
/** Durable input/outbox consumer. Never wait for model execution in this loop. */
export class EntryWorker{
    private timer?:ReturnType<typeof setTimeout>;private running?:Promise<void>;private closed=true;
    constructor(readonly entries:EntryConnections){}
    start(){this.closed=false;this.schedule();}
    private schedule(){if(!this.closed)this.timer=setTimeout(()=>{void this.runOnce().catch(()=>this.entries.host.db.audit('entry.worker_error',{code:'ENTRY_STORAGE_UNAVAILABLE'}).catch(()=>{})).finally(()=>this.schedule());},300).unref();}
    runOnce(){return this.running??=this.tick().finally(()=>{this.running=undefined;});}
    private async deliver(row:any,reply:Record<string,unknown>,text:string,terminal:'replied'|'rejected'|'result_unconfirmed'='replied'){
        const e=this.entries;await e.activeBinding(row);const driver=e.drivers.get(row.connection_id);if(!driver)return;
        const claimed=await e.host.db.pool.query("UPDATE entry_events SET state='replying',updated_at=now() WHERE id=$1 AND state IN ('waiting','error_ready','response_ready') RETURNING id",[row.id]);if(!claimed.rowCount)return;row.state='replying';
        try{await driver.transport.send(reply,text);await e.host.db.pool.query('UPDATE entry_events SET state=$2,updated_at=now() WHERE id=$1',[row.id,terminal]);row.state=terminal;}
        catch{await e.host.db.pool.query("UPDATE entry_events SET state='reply_unknown',updated_at=now() WHERE id=$1",[row.id]);row.state='reply_unknown';}
    }
    private async tick(){
        const e=this.entries,host=e.host;
        await host.db.pool.query("UPDATE entry_events SET state=CASE WHEN state='replying' THEN 'reply_unknown' WHEN work_id IS NULL THEN 'pending' ELSE 'waiting' END WHERE state IN ('processing','replying') AND updated_at<now()-interval '30 seconds'");
        const rows=(await host.db.pool.query("SELECT * FROM entry_events WHERE state IN ('pending','waiting','error_ready','response_ready') ORDER BY CASE WHEN state='pending' AND data->>'command'='true' THEN 0 WHEN state IN ('error_ready','response_ready') THEN 1 WHEN state='pending' THEN 2 ELSE 3 END,updated_at,created_at LIMIT 16")).rows;
        for(const row of rows){let mutationAttempted=false;try{
            const scope=await e.activeBinding(row),message=await e.vault.open<EntryMessage>(row.payload,scope.connection.company_id+':'+row.id);
            if(row.state==='response_ready'){await this.deliver(row,message.reply,row.data.response);continue;}
            if(row.state==='error_ready'){const uncertain=row.data.error?.resultUnconfirmed;await this.deliver(row,message.reply,uncertain?'操作结果待核实，请到公司工作中心核对，勿重复提交。':'操作未执行：'+(errors[row.data.error?.code]??'暂时无法处理，请在公司工作中心核对。'),uncertain?'result_unconfirmed':'rejected');continue;}
            if(row.state==='pending'){
                if(/^\/status\s*$/iu.test(message.text.trim())){
                    const recent=(await host.db.pool.query('SELECT e.work_id,max(e.created_at) AS latest FROM entry_events e JOIN entry_bindings b ON b.id=e.binding_id WHERE b.principal_id=$1 AND e.work_id IS NOT NULL GROUP BY e.work_id ORDER BY latest DESC LIMIT 5',[scope.actor.id])).rows;
                    const lines=[];for(const item of recent){try{const work=await e.work.get(scope.actor.id,item.work_id);lines.push(await e.workReference(scope.actor.companyId,work.id)+' · '+(labels[work.state]??'需要处理'));}catch{}}
                    const response=message.isGroup?'请登录公司工作中心查看本人最近工作。':'最近工作：\n'+(lines.join('\n')||'暂无已受理工作，请稍后再查询。');await host.db.pool.query("UPDATE entry_events SET state='response_ready',data=data||$2::jsonb,updated_at=now() WHERE id=$1",[row.id,JSON.stringify({response})]);continue;
                }
                const text=message.text.trim(),isCommand=text.startsWith('/'),command=/^\/(status|stop|wait|resume)\s+([A-Za-z0-9-]+)(?:\s+([\s\S]*))?$/iu.exec(text);
                if(isCommand&&!command)fail('INVALID_INPUT','Invalid work control command');
                if(command){
                    const kind=command[1]!.toLowerCase(),id=await e.resolveWork(scope.actor.companyId,command[2]!),instruction=command[3]?.trim()??'';
                    if(kind==='resume'&&!instruction)fail('INVALID_INPUT','Resume requires an explicit new instruction');
                    const work=await e.work.get(scope.actor.id,id);
                    if(kind==='status')row.data.statusOnly=true;
                    else{
                        const control=row.data.control??{revision:work.revision,idempotencyKey:'entry:'+row.id,action:kind,reason:instruction||'由已绑定员工通过机器人明确请求',...(kind==='wait'?{waitReason:'human_decision',question:instruction||'等待人工处理'}:{}),...(kind==='resume'?{assignments:[{agentId:scope.agent.id,prompt:instruction}]}:{})};
                        await host.db.pool.query("UPDATE entry_events SET state='processing',data=data||$2::jsonb,updated_at=now() WHERE id=$1",[row.id,JSON.stringify({control})]);mutationAttempted=true;await e.work.control.command(scope.actor.id,id,control);
                    }
                    row.work_id=id;
                }else{
                    await host.db.pool.query("UPDATE entry_events SET state='processing',updated_at=now() WHERE id=$1",[row.id]);
                    mutationAttempted=true;
                    row.work_id=(await e.work.create(scope.actor.id,{title:text.slice(0,80),idempotencyKey:'entry:'+row.id,assignments:[{agentId:scope.agent.id,prompt:text}]})).id;
                }
                await host.db.pool.query("UPDATE entry_events SET state='waiting',work_id=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1",[row.id,row.work_id,JSON.stringify(row.data.statusOnly?{statusOnly:true}:{})]);row.state='waiting';
                await host.db.audit('entry.work_accepted',{principalId:scope.actor.id,agentId:scope.agent.id,eventId:row.id,connectionId:row.connection_id,workId:row.work_id}).catch(()=>{});
            }
            const work=await e.work.get(scope.actor.id,row.work_id);
            if(!row.data.statusOnly&&['queued','running','stop_requested'].includes(work.state)){await host.db.pool.query("UPDATE entry_events SET updated_at=now() WHERE id=$1 AND state='waiting'",[row.id]);continue;}
            const reference=await e.workReference(scope.actor.companyId,work.id),link=host.options.publicOrigin?host.options.publicOrigin+'/#work':'';
            const detail=row.data.statusOnly?'':['waiting_review','completed','changes_requested'].includes(work.state)?work.assignments.map((a:any)=>a.summary).filter(Boolean).join('\n'):work.state==='waiting'?work.control?.question??'':work.state==='reconciliation_required'?'请在公司工作中心核实旧执行结果。':'';
            const text='工作 '+reference+' · '+(labels[work.state]??'需要处理')+(message.isGroup?'\n完整内容请登录公司工作中心查看。':detail?'\n'+detail.slice(0,1800):'')+(link?'\n工作中心：'+link:'');
            if((await e.work.get(scope.actor.id,work.id)).revision!==work.revision)continue;
            await this.deliver(row,message.reply,text);
        }catch(error){
            if(row.state==='replying')continue;
            let active=true;try{await e.activeBinding(row);}catch{active=false;}
            await host.db.pool.query('UPDATE entry_events SET state=$2,data=data||$3::jsonb,work_id=coalesce($4,work_id),updated_at=now() WHERE id=$1',[row.id,active?'error_ready':'blocked',JSON.stringify({error:{code:(error as any).code??'ENTRY_ERROR',resultUnconfirmed:!!row.data.error?.resultUnconfirmed||mutationAttempted||!!row.work_id}}),row.work_id??null]);
        }}
    }
    async close(){this.closed=true;clearTimeout(this.timer);await this.running;}
}
