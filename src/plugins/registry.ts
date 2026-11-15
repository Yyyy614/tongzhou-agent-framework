import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFile, writeFile, mkdir, realpath, readdir, cp, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { satisfies } from 'semver';
import { fail } from '../errors.js';
export interface ToolSpec {
    id: string;
    inputSchema: string;
    outputSchema: string;
    effect: 'read' | 'write' | 'host';
    hostServices?: string[];
}
export interface PluginManifest {
    schemaVersion: '0.1.0' | '0.2.0';
    id: string;
    version: string;
    engine: {
        framework: string;
        protocol: string;
    };
    entry: {
        kind: 'module';
        path: string;
    } | {
        kind: 'remote';
        connectionRef: string;
    };
    permissions: string[];
    provides: {
        tools: ToolSpec[];
        presets: Array<{
            id: string;
            runtimeRef: string;
            instructions: string;
            memoryProfile: string;
            toolRefs: string[];
        }>;
        events: string[];
    };
    configSchema: string;
    dependencies: Array<{
        id: string;
        versionRange: string;
    }>;
}
export interface InstalledPlugin {
    id: string;
    version: string;
    digest: string;
    directory: string;
    manifest: PluginManifest;
    enabled: boolean;
}
export class PluginRegistry {
    private plugins = new Map<string, InstalledPlugin>();
    readonly ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    constructor(private root: string) { }
    async open() {
        await mkdir(resolve(this.root, 'plugins'), { recursive: true });
        try {
            for (const p of JSON.parse(await readFile(resolve(this.root, 'plugins.json'), 'utf8')))
                this.plugins.set(p.id + '@' + p.version, p);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }
    }
    private pendingPersist = Promise.resolve();
    async persist() { const persist = async () => { const temporary = resolve(this.root, 'plugins.' + randomUUID() + '.tmp'); await writeFile(temporary, JSON.stringify([...this.plugins.values()], null, 2)); await rename(temporary, resolve(this.root, 'plugins.json')); }; const job = this.pendingPersist.then(persist); this.pendingPersist = job.catch(() => { }); await job; }
    async packagePath(directory: string, path: string) {
        if (!path.startsWith('./') || path.split(/[\\/]/u).includes('..'))
            fail('INVALID_PACKAGE', 'Package reference must stay inside package');
        const base = await realpath(directory);
        const actual = await realpath(resolve(directory, path));
        const sub = relative(base, actual);
        if (isAbsolute(sub) || sub === '..' || sub.startsWith('..' + sep))
            fail('INVALID_PACKAGE', 'Package reference escaped package');
        return actual;
    }
    async install(directory: string) {
        directory = await realpath(directory);
        const manifest = JSON.parse(await readFile(resolve(directory, 'agent-plugin.json'), 'utf8')) as PluginManifest;
        if (manifest.engine?.protocol !== '1.0' || !satisfies('0.1.0', manifest.engine?.framework ?? ''))
            fail('UNSUPPORTED_VERSION', 'Plugin does not support this host or protocol');
        const schema = JSON.parse(await readFile(new URL('../../plugin.schema.json', import.meta.url), 'utf8'));
        if (!this.ajv.validate(schema, manifest))
            fail('INVALID_PACKAGE', 'Plugin manifest does not satisfy schema', this.ajv.errors);
        for (const dependency of manifest.dependencies)
            if (![...this.plugins.values()].some(p => p.enabled && p.id === dependency.id && satisfies(p.version, dependency.versionRange)))
                fail('MISSING_DEPENDENCY', 'Plugin dependency is not installed');
        const toolIds = new Set(manifest.provides.tools.map(t => t.id));
        if (toolIds.size !== manifest.provides.tools.length)
            fail('INVALID_PACKAGE', 'Duplicate tool id');
        for (const tool of manifest.provides.tools) {
            if (tool.effect === 'host' && (manifest.schemaVersion !== '0.2.0' || !tool.hostServices?.length)) fail('INVALID_PACKAGE', 'Host-effect tools require the 0.2 contract and declared host services');
            if (tool.hostServices?.some(p => !manifest.permissions.includes(p))) fail('INVALID_PACKAGE', 'Tool services must be declared in plugin permissions');
        }
        for (const preset of manifest.provides.presets) {
            await this.packagePath(directory, preset.instructions);
            for (const ref of preset.toolRefs)
                if (!toolIds.has(ref))
                    fail('INVALID_PACKAGE', 'Preset references an undeclared tool');
        }
        const refs = [manifest.configSchema, ...manifest.provides.tools.flatMap(t => [t.inputSchema, t.outputSchema])];
        if (manifest.entry.kind === 'module')
            await this.packagePath(directory, manifest.entry.path);
        for (const ref of refs) {
            const json = JSON.parse(await readFile(await this.packagePath(directory, ref), 'utf8'));
            if (JSON.stringify(json).length > 100000)
                fail('INVALID_PACKAGE', 'Schema is too large');
            this.ajv.compile(json);
        }
        const hash = createHash('sha256');
        let count = 0, bytes = 0;
        const walk = async (path: string) => {
            for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
                if (entry.isSymbolicLink())
                    fail('INVALID_PACKAGE', 'Symbolic links are not allowed');
                const full = resolve(path, entry.name);
                if (entry.isDirectory())
                    await walk(full);
                else if (entry.isFile()) {
                    const data = await readFile(full);
                    bytes += data.length;
                    if (++count > 256 || bytes > 5000000)
                        fail('INVALID_PACKAGE', 'Plugin package exceeds allowed size');
                    hash.update(relative(directory, full).replaceAll('\\', '/'));
                    hash.update(data);
                }
            }
        };
        await walk(directory);
        const digest = hash.digest('hex');
        const key = manifest.id + '@' + manifest.version;
        const prior = this.plugins.get(key);
        if (prior) {
            if (prior.digest !== digest)
                fail('VERSION_CONFLICT', 'An immutable plugin version already has different contents');
            return prior;
        }
        const destination = resolve(this.root, 'plugins', digest);
        await cp(directory, destination, { recursive: true, errorOnExist: true, force: false });
        const plugin: InstalledPlugin = { id: manifest.id, version: manifest.version, digest, directory: destination, manifest, enabled: true };
        this.plugins.set(key, plugin);
        await this.persist();
        return plugin;
    }
    get(id: string, version?: string) {
        const p = [...this.plugins.values()].find(p => p.id === id && (!version || p.version === version));
        if (!p || !p.enabled)
            fail('PLUGIN_UNAVAILABLE', 'Plugin is absent or disabled');
        return p;
    }
    list() { return [...this.plugins.values()]; }
    tools() { return [...this.plugins.values()].filter(p => p.enabled).flatMap(p => p.manifest.provides.tools.map(t => ({ ...t, id: p.id + ':' + t.id, pluginId: p.id, version: p.version }))); }
    async setEnabled(id: string, version: string, enabled: boolean) {
        const p = this.plugins.get(id + '@' + version);
        if (!p)
            fail('PLUGIN_UNAVAILABLE', 'Unknown plugin');
        p.enabled = enabled;
        await this.persist();
    }
    async validateTool(plugin: InstalledPlugin, tool: ToolSpec, input: unknown, output = false) {
        const schema = JSON.parse(await readFile(await this.packagePath(plugin.directory, output ? tool.outputSchema : tool.inputSchema), 'utf8'));
        if (!this.ajv.validate(schema, input))
            fail(output ? 'INVALID_OUTPUT' : 'INVALID_INPUT', 'Tool value does not match declared schema', this.ajv.errors);
    }
}
