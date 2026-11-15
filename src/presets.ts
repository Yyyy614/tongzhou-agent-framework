import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fail } from './errors.js';
export interface PresetRef {
    id: string;
    version: string;
}
export interface CompanyPreset extends PresetRef {
    name: string;
    level: 'worker' | 'lead' | 'coordinator';
    description: string;
    instructions: string;
    order: number;
}
export const companyBundleDirectory = fileURLToPath(new URL('../packages/harness-company-bundle/', import.meta.url));
/** Trusted deployment catalogs. Selecting a preset never changes grants or mounts. */
export class PresetCatalog {
    private definitions = new Map<string, CompanyPreset>();
    async open(directories = [companyBundleDirectory]) {
        for (const directory of directories) {
            const doc = JSON.parse(await readFile(resolve(directory, 'presets.json'), 'utf8'));
            if (doc.protocolVersion !== '1.0' || !/^\d+\.\d+\.\d+$/u.test(doc.version) || !Array.isArray(doc.presets))
                fail('INVALID_INPUT', 'Invalid preset catalog');
            for (const row of doc.presets) {
                if (!row || !/^[a-z][a-z0-9-]{0,79}$/u.test(row.id) || !['worker', 'lead', 'coordinator'].includes(row.level) || typeof row.instructions !== 'string' || row.instructions.length > 8000 || typeof row.name !== 'string' || typeof row.description !== 'string' || !Number.isInteger(row.order))
                    fail('INVALID_INPUT', 'Invalid preset definition');
                const key = row.id + '@' + doc.version;
                if (this.definitions.has(key))
                    fail('CONFLICT', 'Preset version is already registered');
                this.definitions.set(key, { id: row.id, version: doc.version, name: row.name, level: row.level, description: row.description, instructions: row.instructions, order: row.order });
            }
        }
    }
    list() { return [...this.definitions.values()].map(p => ({ ...p })).sort((a, b) => a.order - b.order); }
    get(ref: PresetRef) { const preset = this.definitions.get(ref.id + '@' + ref.version); if (!preset)
        fail('NOT_FOUND', 'Pinned preset version is not installed'); return { ...preset }; }
}
export function nativePresetRows(presets: CompanyPreset[], selected?: {
    ref: PresetRef;
    persona: string;
}) {
    return presets.map(p => ({ id: 'preset-' + p.id, name: '@deepseek-ai/dsh-agent-preset', config: {
            id: p.id, name: p.name, description: p.description, order: p.order,
            plugins: [{ id: p.id + '-persona', name: '@deepseek-ai/dsh-persona', config: { prefix: selected?.ref.id === p.id && selected.ref.version === p.version ? selected.persona : p.instructions, includeRuntimeContext: false } }]
        } }));
}
