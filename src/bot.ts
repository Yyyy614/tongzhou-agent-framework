import { createHash } from 'node:crypto';
import type { Framework } from './index.js';
import type { TaskQueue } from './tasks.js';
import { fail } from './errors.js';
/** Supplied by a trusted entry adapter after authentication and identity mapping. */
export interface BotIdentity {
    principalId: string;
    channelId: string;
}
export interface BotMessage {
    agentId: string;
    conversationId: string;
    messageId: string;
    text: string;
    workId?:string;
    revision?:string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Entry normalization only. Authority, execution, private memory and usage stay in the host. */
export class BotGateway {
    constructor(readonly host: Framework, readonly queue: TaskQueue) { }
    async accept(identity: BotIdentity, message: BotMessage) {
        if (!identity.channelId || identity.channelId.length > 100 || !message.conversationId || message.conversationId.length > 160 || !message.messageId || message.messageId.length > 160 || !message.text?.trim() || message.text.length > 8000)
            fail('INVALID_INPUT', 'Invalid bot message');
        if(!!message.workId!==!!message.revision)fail('INVALID_INPUT','A work follow-up needs its current revision');
        const actor = message.workId?await this.host.db.get<import('./types.js').Actor>('actors',identity.principalId):(await this.host.authorize(identity.principalId, message.agentId)).actor;
        if(!actor.active)fail('PERMISSION_DENIED','Inactive account');
        const key = digest([actor.companyId, actor.id, identity.channelId, message.conversationId, message.messageId]);
        const inputHash = digest(message.workId?[message.agentId,message.text,message.workId,message.revision]:[message.agentId, message.text]);
        // Insert the event identity before enqueueing. A crash between these steps
        // is recoverable by redelivery: the queue key below is deterministic.
        await this.host.db.pool.query('INSERT INTO bot_messages(key,input_hash,principal_id,agent_id) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO NOTHING', [key, inputHash, actor.id, message.agentId]);
        const prior = (await this.host.db.pool.query('SELECT * FROM bot_messages WHERE key=$1', [key])).rows[0];
        if (prior.input_hash !== inputHash)
            fail('CONFLICT', 'Message identity was reused with different content or agent');
        if (prior.task_id)
            return this.queue.get(prior.task_id, actor.id);
        let task;
        if(message.workId){
            if(!this.host.coordination)fail('UNAVAILABLE','Work service is unavailable');
            const receipt=await this.host.coordination.continuity.append(actor.id,message.workId,{revision:message.revision!,idempotencyKey:'bot:'+key,assignments:[{agentId:message.agentId,prompt:message.text}]},{kind:'bot',channelId:identity.channelId,conversationId:message.conversationId,messageId:message.messageId});
            task=await this.queue.get(receipt.taskIds[0]!,actor.id);
        }else task = await this.queue.submit({ principalId: actor.id, agentId: message.agentId, prompt: message.text, idempotencyKey: 'bot:' + key });
        const accepted = await this.host.db.pool.query('UPDATE bot_messages SET task_id=$2 WHERE key=$1 AND task_id IS NULL RETURNING key', [key, task.id]);
        if (accepted.rowCount)
            await this.host.db.audit('bot.message_accepted', { principalId: actor.id, companyId: actor.companyId, agentId: message.agentId, channelId: identity.channelId, eventRef: key, taskId: task.id });
        return task;
    }
}
