import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { contentHash } from './contracts.js';
import { fail } from './errors.js';
import type { PluginRegistry } from './plugins/registry.js';

export interface PackageFile { path: string; contentBase64: string; }
export interface MarketInput { assetKey: string; name: string; summary: string; version: string; kind: 'skill' | 'plugin'; scope: 'personal' | 'department' | 'company'; departmentId?: string; files: PackageFile[]; idempotencyKey: string; }
export const marketInputSchema = { type: 'object', additionalProperties: false, required: ['assetKey', 'name', 'summary', 'version', 'kind', 'scope', 'files', 'idempotencyKey'], properties: {
    assetKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z][a-z0-9._-]*$' }, name: { type: 'string', minLength: 1, maxLength: 100 }, summary: { type: 'string', minLength: 1, maxLength: 1000 }, version: { type: 'string', maxLength: 64 }, kind: { enum: ['skill', 'plugin'] }, scope: { enum: ['personal', 'department', 'company'] }, departmentId: { type: 'string', maxLength: 64 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 }, files: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['path', 'contentBase64'], properties: { path: { type: 'string', minLength: 1, maxLength: 200 }, contentBase64: { type: 'string', maxLength: 2000000 } } } }
} };

/** Untrusted uploads are data only. This function never imports a package or runs scripts. */
export function decodePackage(files: PackageFile[]) {
    const decoded = new Map<string, Buffer>(), seen = new Set<string>(); let bytes = 0;
    for (const file of files) {
        const path = file.path.normalize('NFC'), segments = path.split('/');
        if (path.includes('\\') || path.includes(':') || /[\x00-\x1f]/u.test(path) || segments.some(s => !s || s === '.' || s === '..' || /[. ]$/u.test(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(s)) || segments.some(s => ['.git', '.local', '.tools', '.test-data', 'node_modules'].includes(s.toLowerCase())) || /(?:^|\/)\.env(?!\.example$)(?:\.|$)/iu.test(path) || /\.(?:pem|key|pfx|p12|exe|dll|msi|db|sqlite3?)$/iu.test(path)) fail('INVALID_INPUT', 'Package paths or private file types are not allowed');
        if (seen.has(path.toLowerCase())) fail('INVALID_INPUT', 'Duplicate package path');
        const content = Buffer.from(file.contentBase64, 'base64');
        if (content.toString('base64') !== file.contentBase64 || content.length > 1400000 || (bytes += content.length) > 5000000) fail('INVALID_INPUT', 'Package encoding or size is invalid');
        const text = content.toString('utf8');
        if (/sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|fw_(?:device|entry|client)_[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) fail('INVALID_INPUT', 'Package contains possible credentials; use managed connection references');
        seen.add(path.toLowerCase()); decoded.set(path, content);
    }
    return { files: [...decoded.entries()].sort(([a], [b]) => a.localeCompare(b)), bytes, digest: contentHash([...decoded.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, digest: contentHash(bytes.toString('base64')) }))) };
}
export async function stagePackage(directory: string, files: Array<[string, Buffer]>) {
    await mkdir(directory, { recursive: false, mode: 0o700 });
    for (const [name, body] of files) { const path = resolve(directory, name); if (!path.startsWith(directory + (process.platform === 'win32' ? '\\' : '/'))) fail('INVALID_INPUT', 'Package path escaped staging'); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, body, { flag: 'wx', mode: 0o600 }); }
}
export async function inspectPackage(registry: PluginRegistry, input: MarketInput, directory: string) {
    if (input.kind === 'plugin') {
        if (!input.files.some(f => f.path === 'agent-plugin.json')) fail('INVALID_INPUT', 'Canonical agent-plugin.json is required');
        const inspected = await registry.inspect(directory);
        if (inspected.manifest.id !== input.assetKey || inspected.manifest.version !== input.version) fail('INVALID_INPUT', 'Plugin identity and package metadata differ');
        return { manifest: inspected.manifest, pluginDigest: inspected.digest, entryKind: inspected.manifest.entry.kind };
    }
    if (!input.files.some(f => f.path === 'SKILL.md')) fail('INVALID_INPUT', 'Canonical SKILL.md is required');
    const markdown = await readFile(resolve(directory, 'SKILL.md'), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
    if (!match || markdown.length > 64000) fail('INVALID_INPUT', 'A skill requires bounded SKILL.md frontmatter');
    const document = parseDocument(match[1]!, { uniqueKeys: true, maxAliasCount: 0 } as any);
    if (document.errors.length) fail('INVALID_INPUT', 'Skill frontmatter is invalid');
    const meta = document.toJS({ maxAliasCount: 0 });
    if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(meta.name) || meta.name.length > 64 || meta.name !== input.assetKey.split('/').at(-1) || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) fail('INVALID_INPUT', 'Skill name or description is invalid');
    return { skill: { name: meta.name, description: meta.description, compatibility: typeof meta.compatibility === 'string' ? meta.compatibility.slice(0, 500) : '' } };
}
