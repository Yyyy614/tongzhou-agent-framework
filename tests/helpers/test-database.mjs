import{readFile}from'node:fs/promises';
import pg from'pg';

const loopback=new Set(['127.0.0.1','localhost','[::1]','::1']);
export async function testDatabase(url=process.env.DATABASE_URL){
    let database;
    if(url){
        let parsed;try{parsed=new URL(url);}catch{throw Error('PostgreSQL URL required for crash tests');}
        if(!['postgres:','postgresql:'].includes(parsed.protocol))throw Error('PostgreSQL URL required for crash tests');
        database={connectionString:url};
    }else database=JSON.parse(await readFile('.local/database.json','utf8'));
    let host;try{host=new pg.Client(database).connectionParameters.host;}catch{throw Error('Invalid PostgreSQL configuration for crash tests');}
    if(!loopback.has(host))throw Error('Crash tests require a loopback database');
    return database;
}
