import { RemotePeer, type Connection } from './plugins/remote.js';
import { fail } from './errors.js';
export interface RuntimeContext {
    companyId: string;
    principalId: string;
    agentId: string;
    runId: string;
    pluginId: string;
    pluginVersion: string;
    gateway: {
        modelURL: string;
        mcpURL: string;
        token: string;
    };
}
export class RemoteAgentAdapter {
    private peer: RemotePeer;
    private remoteRunId?: string;
    private cancellationRequested = false;
    private cancellationUnknown = false;
    constructor(connection: Connection) { this.peer = new RemotePeer(connection); }
    async run(prompt: string, context: RuntimeContext) {
        const started = await this.peer.call('run.start', { protocol: '1.0', prompt, context, idempotencyKey: context.runId }, 15000);
        if (typeof started?.runId !== 'string')
            fail('RESULT_UNKNOWN', 'Remote run.start omitted run id; reconcile the accepted operation');
        this.remoteRunId = started.runId;
        if (this.cancellationRequested)
            await this.requestCancellation();
        const deadline = Date.now() + 120000;
        let state = started.state;
        while (!['succeeded', 'failed', 'cancelled', 'reconciliation_required'].includes(state)) {
            if (this.cancellationUnknown)
                fail('RESULT_UNKNOWN', 'Remote cancellation outcome is unknown');
            if (Date.now() > deadline)
                fail('RESULT_UNKNOWN', 'Remote task result requires reconciliation');
            await new Promise(r => setTimeout(r, 150));
            const status = await this.peer.call('run.status', { runId: this.remoteRunId }, 15000);
            if (!['queued', 'running', 'waiting_approval', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'reconciliation_required'].includes(status?.state))
                fail('RESULT_UNKNOWN', 'Remote status receipt is invalid');
            state = status.state;
        }
        if (state !== 'succeeded')
            fail(state === 'cancelled' ? 'CANCELLED' : state === 'reconciliation_required' ? 'RESULT_UNKNOWN' : 'REMOTE_FAILED', 'Remote task ended without success');
        const result = await this.peer.call('run.result', { runId: this.remoteRunId }, 15000);
        if (typeof result?.output !== 'string' || result.output.length > 16000)
            fail('RESULT_UNKNOWN', 'Invalid remote task result; reconcile completed actions');
        if (result.usage && (!Number.isInteger(result.usage.inputTokens) || !Number.isInteger(result.usage.outputTokens) || result.usage.inputTokens < 0 || result.usage.outputTokens < 0))
            fail('RESULT_UNKNOWN', 'Invalid reported usage; reconciliation is required');
        return { sessionId: this.remoteRunId!, finishReason: 'end_turn', finalResponse: result.output, events: [], usage: result.usage };
    }
    private async requestCancellation() {
        try {
            const result = await this.peer.call('run.cancel', { runId: this.remoteRunId }, 5000);
            if (typeof result?.accepted !== 'boolean')
                fail('RESULT_UNKNOWN', 'Remote cancellation omitted acceptance');
            return result as {
                accepted: boolean;
            };
        }
        catch (error) {
            this.cancellationUnknown = true;
            throw error;
        }
    }
    async cancel() { this.cancellationRequested = true; return this.remoteRunId ? this.requestCancellation() : { accepted: true, pending: true }; }
    stopMonitoring() { this.cancellationUnknown = true; }
}
