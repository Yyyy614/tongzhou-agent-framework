import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './persistence.js';
import type { MemoryRequest, MemoryWrite, MemoryNote, ContextRequest } from './types.js';
import { fail } from './errors.js';
export class MemoryStore {
    constructor(private root: string, private db: Database, private authorize: (principal: string, agent: string, action: 'read' | 'execute') => Promise<unknown>) { }
    private validate(noteId: string) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(noteId))
            fail('INVALID_INPUT', 'Note id must be a simple identifier');
    }
    private note(row: any): MemoryNote { return { noteId: row.note_id, version: row.version, markdown: row.markdown, sourceRefs: row.source_refs, updatedAt: new Date(row.updated_at).toISOString() }; }
    async list(request: {
        principalId: string;
        agentId: string;
    }) { await this.authorize(request.principalId, request.agentId, 'read'); const rows = (await this.db.pool.query('SELECT note_id,version,markdown,source_refs,updated_at FROM memories WHERE agent_id=$1 ORDER BY note_id LIMIT 200', [request.agentId])).rows; return rows.map(row => ({ noteId: row.note_id, version: row.version, excerpt: row.markdown.slice(0, 120), characters: row.markdown.length, links: [...row.markdown.matchAll(/\[\[([A-Za-z0-9_-]+)\]\]/gu)].map(m => m[1]), sourceRefs: row.source_refs, updatedAt: new Date(row.updated_at).toISOString() })); }
    async read(request: MemoryRequest) {
        await this.authorize(request.principalId, request.agentId, 'read');
        this.validate(request.noteId);
        const row = (await this.db.pool.query('SELECT * FROM memories WHERE agent_id=$1 AND note_id=$2', [request.agentId, request.noteId])).rows[0];
        if (!row)
            fail('NOT_FOUND', 'Memory note does not exist');
        return this.note(row);
    }
    async write(request: MemoryWrite) {
        await this.authorize(request.principalId, request.agentId, 'execute');
        this.validate(request.noteId);
        if (typeof request.markdown !== 'string' || request.markdown.length > 32000 || !Number.isInteger(request.expectedVersion) || request.expectedVersion < 0 || !Array.isArray(request.sourceRefs) || request.sourceRefs.length > 32 || request.sourceRefs.some(s => typeof s !== 'string' || s.length > 240))
            fail('INVALID_INPUT', 'Invalid memory write');
        const result = request.expectedVersion === 0
            ? await this.db.pool.query('INSERT INTO memories(agent_id,note_id,version,markdown,source_refs) VALUES($1,$2,1,$3,$4) ON CONFLICT DO NOTHING RETURNING *', [request.agentId, request.noteId, request.markdown, JSON.stringify(request.sourceRefs)])
            : await this.db.pool.query('UPDATE memories SET version=version+1,markdown=$3,source_refs=$4,updated_at=now() WHERE agent_id=$1 AND note_id=$2 AND version=$5 RETURNING *', [request.agentId, request.noteId, request.markdown, JSON.stringify(request.sourceRefs), request.expectedVersion]);
        if (!result.rowCount)
            fail('CONFLICT', 'Memory version changed; read and reconcile first');
        const note = this.note(result.rows[0]);
        await this.db.audit('memory.updated', { principalId: request.principalId, agentId: request.agentId, noteId: request.noteId, version: note.version, sourceRefs: note.sourceRefs });
        // PostgreSQL is authoritative. Markdown is an inspectable projection, never an ACL.
        const directory = resolve(this.root, 'memory', createHash('sha256').update(request.agentId).digest('hex'));
        try {
            await mkdir(directory, { recursive: true });
            const tmp = resolve(directory, request.noteId + '.' + randomUUID() + '.tmp');
            await writeFile(tmp, `---\nnote: ${note.noteId}\nversion: ${note.version}\n---\n${note.markdown}`);
            await rename(tmp, resolve(directory, request.noteId + '.md'));
        }
        catch {
            await this.db.audit('memory.projection_pending', { agentId: request.agentId, noteId: request.noteId, version: note.version });
        }
        return note;
    }
    async search(request: {
        principalId: string;
        agentId: string;
        query: string;
    }) {
        await this.authorize(request.principalId, request.agentId, 'read');
        if (typeof request.query !== 'string' || request.query.length > 200)
            fail('INVALID_INPUT', 'Invalid query');
        return (await this.db.pool.query('SELECT note_id,version,left(markdown,240) AS excerpt FROM memories WHERE agent_id=$1 AND (note_id ILIKE $2 OR markdown ILIKE $2) ORDER BY note_id LIMIT 12', [request.agentId, '%' + request.query + '%'])).rows;
    }
    async context(request: ContextRequest) {
        await this.authorize(request.principalId, request.agentId, 'read');
        const max = request.maxChars ?? 8000;
        if (!Array.isArray(request.noteIds) || request.noteIds.length > 12 || !Number.isInteger(max) || max < 1 || max > 16000)
            fail('INVALID_INPUT', 'Context budget exceeds limits');
        let text = '';
        const refs: Array<{
            noteId: string;
            version: number;
        }> = [];
        let truncated = false;
        for (const noteId of [...new Set(request.noteIds)]) {
            let note: MemoryNote;
            try {
                note = await this.read({ ...request, noteId });
            }
            catch (e) {
                if ((e as {
                    code?: string;
                }).code === 'NOT_FOUND')
                    continue;
                throw e;
            }
            const block = `\n[${noteId}@${note.version}]\n${note.markdown}\n`;
            if (text.length + block.length > max) {
                truncated = true;
                continue;
            }
            text += block;
            refs.push({ noteId, version: note.version });
        }
        return { text, refs, truncated, budgetChars: max };
    }
}
