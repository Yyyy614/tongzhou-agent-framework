import { companyOrigin } from '../client/employee-app.mjs';
/** Only public deployment settings are allowed in an employee distribution. */
export function companyReleaseConfig({serverURL='http://127.0.0.1:4417',dataNamespace='v04-isolated',version='0.4.0',productName,integratedChrome}={}){
    if(!/^[A-Za-z0-9_-]{1,40}$/u.test(dataNamespace))throw Error('Invalid company data namespace');
    if(!/^\d+\.\d+\.\d+$/u.test(version))throw Error('Invalid company release version');
    if(productName!==undefined&&(typeof productName!=='string'||!productName.trim()||productName.length>64||/[\u0000-\u001f\u007f]/u.test(productName)))throw Error('Invalid company product name');
    if(integratedChrome!==undefined&&typeof integratedChrome!=='boolean')throw Error('Invalid company window style');
    return{version,serverURL:companyOrigin(serverURL),dataNamespace,...(productName!==undefined?{productName}:{}),...(integratedChrome!==undefined?{integratedChrome}:{})};
}
