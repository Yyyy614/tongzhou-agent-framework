/** Portable host-facing plugin contract. Plugins never receive model keys or arbitrary principals. */
export interface CallContext {
    runRef: string;
    signal: AbortSignal;
    services: {
        connections: { catalog(): Promise<{ items: Array<{ id: string; name: string; kind: string; protocol: string; reference: string; excerpt: string }> }>; describe(id: string): Promise<{ id: string; name: string; reference: string; protocol: string; documentation: string; baseURL: string }> };
        team: { list(): Promise<unknown> };
        work: {
            dispatch(input: { title: string; assignments: Array<{ agentId: string; prompt: string }>; dueAt?: string; subjectRef?: { system: string; id: string } }): Promise<unknown>;
            list(): Promise<{ items: unknown[] }>;
            read(id: string): Promise<unknown>;
        };
        reminders: {
            schedule(input: { title: string; dueAt: string; details?: string; agentId?: string; subjectRef?: { system: string; id: string } }): Promise<unknown>;
            list(): Promise<{ items: unknown[] }>;
        };
        inbox: { list(): Promise<{ items: unknown[] }> };
        events: { publish(input: { type: string; summary: string; subjectRef?: { system: string; id: string } }): Promise<unknown> };
        memory: {
            read(ref: {
                noteId: string;
            }): Promise<{
                noteId: string;
                version: number;
                markdown: string;
            }>;
            proposeWrite(entry: {
                noteId: string;
                markdown: string;
                expectedVersion: number;
                sourceRefs: string[];
            }): Promise<unknown>;
        };
        reports: {
            record(record: {
                summary: string;
            }): Promise<{
                evidenceRef: string;
            }>;
        };
    };
}
export interface PluginContext {
    config: Readonly<Record<string, unknown>>;
    tools: {
        register(id: string, handler: (input: any, context: CallContext) => Promise<unknown>): void;
    };
}
export interface PluginModule {
    apply(context: PluginContext): void | Promise<void>;
    shutdown?(): void | Promise<void>;
}
