import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Standalone authoring tool: it does not import the framework, DB or credentials.
const args = process.argv.slice(2);
if (args.length !== 3 || args[1] !== '--id' || !/^@[a-z0-9-]+\/[a-z0-9-]+$/u.test(args[2])) {
    throw Error('Usage: node scripts/create-plugin.mjs <new-directory> --id @scope/package');
}
const directory = resolve(args[0]), id = args[2];
await mkdir(directory); // Never overwrite an existing developer project.
await mkdir(resolve(directory, 'schemas'));
await mkdir(resolve(directory, 'presets'));
const json = (path, value) => writeFile(resolve(directory, path), JSON.stringify(value, null, 2) + '\n');
await json('package.json', { name: id, version: '0.1.0', type: 'module', exports: './plugin.mjs', files: ['agent-plugin.json', 'plugin.mjs', 'schemas', 'presets'] });
await json('agent-plugin.json', {
    schemaVersion: '0.1.0', id, version: '0.1.0', engine: { framework: '>=0.1.0 <0.2.0', protocol: '1.0' },
    entry: { kind: 'module', path: './plugin.mjs' }, permissions: [],
    provides: { tools: [{ id: 'record.inspect', inputSchema: './schemas/input.json', outputSchema: './schemas/output.json', effect: 'read' }],
        presets: [{ id: 'record-worker', runtimeRef: 'harness', instructions: './presets/worker.md', memoryProfile: 'agent-private', toolRefs: ['record.inspect'] }], events: [] },
    configSchema: './schemas/config.json', dependencies: [],
});
const text = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 16000 } } };
await json('schemas/input.json', text);
await json('schemas/output.json', text);
await json('schemas/config.json', { type: 'object', additionalProperties: false, properties: {} });
await writeFile(resolve(directory, 'plugin.mjs'), 'export function apply(ctx) {\n    ctx.tools.register("record.inspect", async input => ({ text: input.text.trim() }));\n}\n');
await writeFile(resolve(directory, 'presets/worker.md'), 'Use only granted tools. Report actual results. Ask for missing facts; do not invent them.\n');
await writeFile(resolve(directory, 'README.md'), '# ' + id + '\n\nIndependent capability package. Replace plugin.mjs and its input/output schemas with your business behavior. Do not import host implementation files.\n\nValidate with the framework CLI: `node scripts/check-plugin.mjs <this-directory>`. Install through the trusted host or admin plugin interface, then grant the employee and Agent the exact tool reference. Package permissions are requests, not grants. Publish a new version when changing installed contents.\n');
console.log(JSON.stringify({ created: true, directory, id, version: '0.1.0' }));
