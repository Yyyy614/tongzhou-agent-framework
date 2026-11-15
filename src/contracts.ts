import { createHash } from 'node:crypto';
import { fail } from './errors.js';
export function requireUuid(value: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value)) fail('INVALID_INPUT', 'Invalid reference');
    return value;
}
export function zonedTimestamp(value: string) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_INPUT', 'Use an ISO timestamp with an explicit time zone');
    return new Date(value).toISOString();
}
export function contentHash(value: unknown): string {
    const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export type RunState = 'queued' | 'running' | 'waiting_approval' | 'waiting_external' | 'reconciliation_required' | 'succeeded' | 'failed' | 'cancelled';
