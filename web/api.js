const publicBase=globalThis.document?.querySelector?.('meta[name="company-base-path"]')?.content??'';
export const entryEnabled=globalThis.document?.querySelector?.('meta[name="company-entries"]')?.content==='1';
export class ApiError extends Error {
    constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
const messages = { UNAUTHENTICATED: '登录已过期，请重新打开管理后台。', PERMISSION_DENIED: '没有此操作的权限，请检查员工授权、岗位状态和工具范围。', CONFLICT: '记录已变化或当前仍有任务运行。请重新读取后再操作，当前修改不会自动覆盖。', INVALID_INPUT: '配置格式不符合要求，请检查必填项和 JSON 内容。', INVALID_OUTPUT: '工具返回内容未通过格式检查，请查看运行日志。', PLUGIN_UNAVAILABLE: '插件未启用或版本不可用，请先检查插件状态。', APPROVAL_REQUIRED: '此写操作需要管理员对本次输入进行审批，尚未执行。', RESULT_UNKNOWN: '执行结果需要核对，请查看日志，勿直接重复执行。', BUDGET_EXCEEDED: '本次任务的用量或并发额度已用完。', CONTEXT_BUDGET_EXCEEDED: '任务上下文超过预算，请缩减内容。', NOT_FOUND: '记录不存在或尚未创建。' };
export async function api(path, method = 'GET', data) {
    let response;
    try {
        response = await fetch(publicBase+path, { method, credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    }
    catch {
        throw new ApiError(method==='GET'?'NETWORK':'RESULT_UNKNOWN',method==='GET'?'无法连接内核服务，请检查服务是否运行。':'操作回执未收到，结果可能已登记。请保持原输入核对，不要另建重复操作。', 0);
    }
    if(response.status===204)return {ok:true};
    let body;try{body=await response.json();}catch{throw new ApiError(method==='GET'?'INVALID_OUTPUT':'RESULT_UNKNOWN',method==='GET'?messages.INVALID_OUTPUT:messages.RESULT_UNKNOWN,response.status);}
    if(!body||typeof body!=='object')throw new ApiError(method==='GET'?'INVALID_OUTPUT':'RESULT_UNKNOWN',messages.RESULT_UNKNOWN,response.status);
    if (!response.ok) {
        const code = body.error?.code ?? 'ERROR';
        throw new ApiError(code, messages[code] ?? body.error?.message ?? '操作没有完成，请重试。', response.status);
    }
    return body;
}
export function parseJson(value, label = '配置') { try {
    return JSON.parse(value);
}
catch {
    throw new Error(label + '不是有效的 JSON，请检查引号和逗号。');
} }
export const idempotency = () => crypto.randomUUID();

