/** Shared wire transport for employee and developer Harness entry points. */
export function companyFetch(origin, path, { method = 'GET', body, token, timeoutMs = 20000 } = {}) {
    return fetch(origin + path, { method, redirect: 'error', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
}
