import { PresetCatalog, nativePresetRows, companyBundleDirectory } from '../dist/presets.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
const catalog = new PresetCatalog();
await catalog.open();
await writeFile(resolve(companyBundleDirectory, 'cordis.patch.yml'), '# Generated from presets.json by npm run build. Native Harness bundle patch.\n' + stringify([{ insert: nativePresetRows(catalog.list()) }]));
