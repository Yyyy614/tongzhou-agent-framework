import{readFile}from'node:fs/promises';

const loopback=new Set(['127.0.0.1','localhost','[::1]','::1']);
export async function testDatabase(url=process.env.DATABASE_URL){
    if(url){
        const parsed=new URL(url);
        if(!['postgres:','postgresql:'].includes(parsed.protocol))throw Error('PostgreSQL URL required for crash tests');
        if(!loopback.has(parsed.hostname))throw Error('Crash tests require a loopback database');
        return{connectionString:url};
    }
    const database=JSON.parse(await readFile('.local/database.json','utf8'));
    if(!loopback.has(database.host))throw Error('Crash tests require a loopback database');
    return database;
}
