const uuid = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/giu;
export function readableText(text, names = {}) {
    let result = String(text ?? '');
    return result.replace(/\b(?:invocationId|evidenceRefs?|runId|taskId|eventId)\s*[:：]?\s*`?[^\s，。；;\n）)]+`?/giu, '执行记录已留存')
        .replace(uuid, '〔记录〕').replace(/@[a-z0-9-]+\/[a-z0-9-]+:[a-z][a-z0-9_.-]+/giu, value => value.endsWith(':text.normalize') ? '文本规范化工具' : '已授权工具')
        .replace(/(状态|执行结果|outcome|status)\s*[:=：]\s*`?(succeeded|failed|waiting_review)`?/giu, (_,label,value) => (['outcome','status'].includes(label.toLowerCase())?'执行结果':label)+'：'+({succeeded:'成功',failed:'失败',waiting_review:'等待核对'})[value.toLowerCase()])
        .replace(/(?:执行记录已留存[，、\s`]*){2,}/gu, '执行记录已留存').replace(/\n{3,}/gu, '\n\n');
}
/** Small safe Markdown renderer: never inserts model HTML or activates model links. */
export function resultView(raw, { names = {}, technical } = {}) {
    const root = document.createElement('div'); root.className = 'result-text';
    for (const line of readableText(raw, names).split('\n')) {
        if (!line.trim()) continue;
        const paragraph = document.createElement(/^#{1,4} /u.test(line) ? 'h4' : 'p');
        const text = line.replace(/^#{1,4} /u, '').replace(/^[-*] /u, '• ');
        const pieces = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/gu);
        for (const piece of pieces) {
            const strong = piece.startsWith('**') && piece.endsWith('**');
            const code = piece.startsWith('`') && piece.endsWith('`');
            const span = document.createElement(strong ? 'strong' : 'span');
            span.textContent = strong ? piece.slice(2, -2) : code ? piece.slice(1, -1) : piece; paragraph.append(span);
        }
        root.append(paragraph);
    }
    if (technical !== undefined) {
        const details = document.createElement('details'), label = document.createElement('summary'), pre = document.createElement('pre');
        details.className = 'technical-record'; label.textContent = '技术记录（排查时查看）';
        pre.textContent = JSON.stringify(technical, null, 2); details.append(label, pre); root.append(details);
    }
    return root;
}
