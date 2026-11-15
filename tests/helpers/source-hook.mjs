// Run the current source in a separate Node process; never depend on stale dist output.
import{registerHooks,stripTypeScriptTypes}from'node:module';
import{readFileSync,existsSync}from'node:fs';
import{fileURLToPath}from'node:url';
registerHooks({resolve(specifier,context,next){
    if(specifier.endsWith('.js')&&context.parentURL?.includes('/src/')){const candidate=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(candidate))return next(candidate.href,context);}
    return next(specifier,context);
},load(url,context,next){
    if(url.endsWith('.ts')&&url.includes('/src/'))return{format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform',sourceUrl:url}),shortCircuit:true};
    return next(url,context);
}});
