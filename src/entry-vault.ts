import{randomBytes,createCipheriv,createDecipheriv}from'node:crypto';
import{readFile,writeFile,mkdir}from'node:fs/promises';
import{resolve}from'node:path';
/** Private host storage, never an employee or model credential. */
export class EntryVault{
    private key?:Promise<Buffer>;
    constructor(readonly root:string){}
    private load(){return this.key??=(async()=>{await mkdir(this.root,{recursive:true});const path=resolve(this.root,'.entry-key');try{return await readFile(path);}catch(error){if((error as any).code!=='ENOENT')throw error;const key=randomBytes(32);try{await writeFile(path,key,{flag:'wx',mode:0o600});return key;}catch(error){if((error as any).code!=='EEXIST')throw error;return readFile(path);}}})();}
    async seal(value:unknown,scope:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await this.load(),iv);cipher.setAAD(Buffer.from(scope));return this.encrypt(cipher,iv,value);}
    private encrypt(cipher:ReturnType<typeof createCipheriv>,iv:Buffer,value:unknown){const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,(cipher as any).getAuthTag(),bytes]).toString('base64url');}
    async open<T=any>(value:string,scope:string):Promise<T>{const bytes=Buffer.from(value,'base64url'),cipher=createDecipheriv('aes-256-gcm',await this.load(),bytes.subarray(0,12));cipher.setAAD(Buffer.from(scope));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));}
}
