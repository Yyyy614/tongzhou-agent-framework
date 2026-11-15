import { companyOrigin } from '../client/employee-app.mjs';
/** Only public deployment settings are allowed in an employee distribution. */
export function companyReleaseConfig({serverURL='http://127.0.0.1:4417',dataNamespace='v04-isolated',version='0.4.0'}={}){
    if(!/^[A-Za-z0-9_-]{1,40}$/u.test(dataNamespace))throw Error('Invalid company data namespace');
    if(!/^\d+\.\d+\.\d+$/u.test(version))throw Error('Invalid company release version');
    return{version,serverURL:companyOrigin(serverURL),dataNamespace};
}
