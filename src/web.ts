import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
export function registerWeb(app: FastifyInstance,options:{publicBasePath:string;entries:boolean;profile?:'classic'|'studio'}={publicBasePath:'',entries:false}) {
    const files: Record<string, {
        file: string;
        type: string;
    }> = { '/': { file: 'index.html', type: 'text/html; charset=utf-8' }, '/console': { file: 'index.html', type: 'text/html; charset=utf-8' }, '/console/': { file: 'index.html', type: 'text/html; charset=utf-8' } };
    for (const name of ['app.js', 'api.js', 'ui.js', 'views.js', 'editors.js', 'employee-access.js', 'coordination-views.js', 'result-view.mjs', 'channels-view.js','entry-view.js'])
        files['/assets/' + name] = { file: name, type: 'application/javascript; charset=utf-8' };
    files['/assets/styles.css'] = { file: 'styles.css', type: 'text/css; charset=utf-8' };
    const studio=options.profile==='studio';
    if(studio){
        files['/assets/base-views.js']={file:'views.js',type:'application/javascript; charset=utf-8'};
        files['/assets/base-ui.js']={file:'ui.js',type:'application/javascript; charset=utf-8'};
        files['/assets/ui.js']={file:'studio/ui.js',type:'application/javascript; charset=utf-8'};
        for(const name of ['studio-overview.js','studio-employee.js','studio-shell.js'])files['/assets/'+name]={file:'studio/'+name,type:'application/javascript; charset=utf-8'};
        files['/assets/company-theme.css']={file:'studio/theme.css',type:'text/css; charset=utf-8'};
        files['/assets/company-tokens.css']={file:'../packages/company-ui/tokens.css',type:'text/css; charset=utf-8'};
        files['/assets/brand.mjs']={file:'../packages/company-ui/brand.mjs',type:'application/javascript; charset=utf-8'};
        files['/assets/brand-mark.svg']={file:'../packages/company-ui/assets/mark.svg',type:'image/svg+xml'};
    }
    for (const [url, { file, type }] of Object.entries(files))
        app.get(url, async (request, reply) => {
            const source=studio&&['index.html','app.js'].includes(file)?'studio/'+file:file;
            let body=await readFile(new URL('../web/'+source,import.meta.url),'utf8');
            if(file==='index.html')body=body.replace('<head>','<head><meta name="company-base-path" content="'+options.publicBasePath+'"><meta name="company-entries" content="'+(options.entries?'1':'0')+'">').replaceAll('="/assets/','="'+options.publicBasePath+'/assets/');
            return reply.header('Content-Type', type).header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'").send(body);
        });
}
