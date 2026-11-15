export interface Actor {
    id: string;
    companyId: string;
    role: 'admin' | 'employee';
    permissions: string[];
    active?: boolean;
    displayName?: string;
    department?: string;
    departmentId?: string | null;
    managerId?: string | null;
    teamScope?: 'none' | 'direct' | 'subtree';
}
export interface PluginBinding {
    pluginId: string;
    pluginVersion: string;
    config?: Record<string, unknown>;
}
export interface Agent {
    preset?: import('./presets.js').PresetRef;
    id: string;
    companyId: string;
    ownerId: string;
    pluginId: string;
    pluginVersion: string;
    config?: Record<string, unknown>;
    plugins?: PluginBinding[];
    allowedTools: string[];
    delegates?: string[];
    servicePermissions?: string[];
    preferences?: {
        replyStyle: string;
    };
    active?: boolean;
    instructions?: string;
    runtime?: 'harness' | 'remote';
    connectionRef?: string;
    displayName?: string;
}
export interface Invocation {
    principalId: string;
    agentId: string;
    toolRef: string;
    input: unknown;
    idempotencyKey: string;
    runId?: string;
}
export interface Receipt {
    invocationId: string;
    runId: string;
    outcome: 'succeeded' | 'failed' | 'unknown';
    output: unknown;
    evidenceRefs: string[];
}
export interface MemoryRequest {
    principalId: string;
    agentId: string;
    noteId: string;
}
export interface MemoryNote {
    noteId: string;
    version: number;
    markdown: string;
    sourceRefs: string[];
    updatedAt: string;
}
export interface MemoryWrite extends MemoryRequest {
    markdown: string;
    expectedVersion: number;
    sourceRefs: string[];
}
export interface ContextRequest {
    principalId: string;
    agentId: string;
    noteIds: string[];
    maxChars?: number;
}
