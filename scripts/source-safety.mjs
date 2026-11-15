/** Publication checks report locations and rule names, never matched credential values. */
export function sourceIssues(path,bytes){
    const normalized=path.replaceAll('\\','/'),issues=[];
    if(/(?:^|\/)(?:\.local|\.tools|\.test-data|node_modules|output|artifacts|\.git)(?:\/|$)/u.test(normalized)||/(?:^|\/)\.env(?:$|\.)/u.test(normalized)&&!normalized.endsWith('.env.example')||/\.(?:pem|key|pfx|p12|exe|msi|dmp)$/iu.test(normalized))issues.push({path,rule:'private-or-generated-file'});
    if(/\.(?:png|jpe?g|ico|woff2)$/iu.test(normalized))return issues;
    const text=bytes.toString('utf8');
    const rules=[['model-key',/sk-[A-Za-z0-9_-]{20,}/gu],['github-token',/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})/gu],['private-key',/-----BEGIN (?:RSA |OPENSSH |EC |ED25519 )?PRIVATE KEY-----/gu],['device-token',/fw_(?:entry|device)_[A-Za-z0-9_-]{20,}/gu]];
    for(const[rule,pattern]of rules)for(const match of text.matchAll(pattern)){
        // These two sources contain the same explicit, non-provider redaction fixture.
        if(['tests/logs.test.ts','scripts/source-safety.mjs'].includes(normalized)&&match[0]==='sk-thisisatestsecretvalue')continue;
        issues.push({path,rule,line:text.slice(0,match.index).split('\n').length});
    }
    return issues;
}
