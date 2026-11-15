import {test,expect} from 'vitest';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createFramework} from '../src/index.js';
test('the independent market example consumes job configuration through the actual plugin protocol',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/market-example-'))});
    try{await host.installPlugin(resolve('examples/plugins/market-text'));await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:['tool.invoke:@example/market-text:text.format']});await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@example/market-text',pluginVersion:'0.1.1',allowedTools:['@example/market-text:text.format'],config:{prefix:'[verified] '}});const receipt=await host.invoke({principalId:'alice',agentId:'job',toolRef:'@example/market-text:text.format',input:{text:'  alpha   beta '},idempotencyKey:'one'});expect(receipt.output).toEqual({text:'[verified] ALPHA BETA'});}finally{await host.close();}
});
