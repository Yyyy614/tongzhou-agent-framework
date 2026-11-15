/** Refuse to claim pre-existing cloud records from names alone. No I/O occurs here. */
export function guardCloudFixture({serverURL,username,agentIds,actorIds,allAgentIds,employees,agents,account}){
    const collision=employees.some(actor=>actorIds.includes(actor.id))||agents.some(agent=>allAgentIds.includes(agent.id));
    if(collision&&!account)throw Error('Cloud test IDs already exist; refusing to claim or reset an existing account');
    if(account&&(account.serverURL!==serverURL||account.username!==username||JSON.stringify(account.agentIds)!==JSON.stringify(agentIds)))throw Error('Cloud fixture ownership record does not match this deployment');
    if(collision&&!account?.registered)throw Error('Incomplete cloud fixture ownership; operator reconciliation is required, no automatic password reset');
    return{mayCreateEmployee:!employees.some(actor=>actor.id===username)};
}
