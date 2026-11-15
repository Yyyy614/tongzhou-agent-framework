// Use the pinned TypeScript parser/printer; no global formatter download is needed.
import ts from 'typescript';
import { readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
function walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else if(path.endsWith('.ts')){const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);writeFileSync(path,ts.createPrinter({newLine:ts.NewLineKind.LineFeed}).printFile(source));}}}
walk('src');walk('tests');
