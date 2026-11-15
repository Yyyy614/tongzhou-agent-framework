export function h(tag, attributes = {}, ...children) { const node = document.createElement(tag); for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false)
        continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
} for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null)
        continue;
    if (key.startsWith('on'))
        node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class')
        node.className = value;
    else if (key === 'style')
        Object.assign(node.style, value);
    else if (key in node && !key.startsWith('aria-') && !key.startsWith('data-'))
        node[key] = value;
    else
        node.setAttribute(key, String(value));
} return node; }
const paths = { grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', bot: 'M12 3v3M9 3h6M5 9h14v11H5zM2 13v4M22 13v4M9 13h.01M15 13h.01M9 17h6', box: 'm12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5', brain: 'M9 18c-5 1-7-5-4-7-2-4 2-7 5-5V4a2 2 0 0 1 4 0v2c3-2 7 1 5 5 3 2 1 8-4 7M12 4v18M8 11l4 2 4-2M7 16l5 2 5-2', activity: 'M3 12h4l3-8 4 16 3-8h4', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', plus: 'M12 5v14M5 12h14', search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', check: 'm5 12 4 4L19 6', x: 'm6 6 12 12M6 18 18 6', arrow: 'M4 12h16m-6-6 6 6-6 6', chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6', logout: 'M9 4H4v16h5M9 12h12m-5-5 5 5-5 5', play: 'm8 4 13 8-13 8V4Z', refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2', shield: 'm12 3 9 4v6c0 5-9 9-9 9s-9-4-9-9V7l9-4Zm-4 9 3 3 5-6', link: 'm10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0', menu: 'M3 6h18M3 12h18M3 18h18', file: 'M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h6', clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', copy: 'M8 8h13v13H8zM4 16H2V2h14v2' };
export function icon(name, size = 18) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }))
    svg.setAttribute(k, String(v)); const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] ?? paths.box); svg.append(path); return svg; }
export function button(label, onClick, kind = 'secondary', extra = {}) { return h('button', { type: 'button', class: 'button ' + kind, onClick, ...extra }, label); }
export function badge(text, kind = 'neutral') { return h('span', { class: 'badge ' + kind }, h('span', { class: 'badge-dot' }), text); }
const states = { succeeded: ['已完成', 'success'], failed: ['失败', 'danger'], running: ['运行中', 'primary'], queued: ['排队中', 'neutral'], cancelled: ['已取消', 'neutral'], waiting_approval: ['待审批', 'warning'], reconciliation_required: ['待核对', 'warning'] };
export const stateBadge = state => badge(...(states[state] ?? [state, 'neutral']));
export const activeBadge = active => badge(active ? '已启用' : '已停用', active ? 'success' : 'neutral');
export function avatar(name, kind = 'blue') { return h('span', { class: 'avatar ' + kind }, String(name ?? '?').slice(0, 2).toUpperCase()); }
export function nameCell(name, id, kind) { return h('div', { class: 'name-cell' }, avatar(name, kind), h('div', {}, h('strong', {}, name), h('span', { class: 'sub-id' }, id))); }
export const number = value => new Intl.NumberFormat('zh-CN').format(value ?? 0);
export const date = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
export function table(columns, rows, { empty = '暂无记录', onRow } = {}) { return h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, columns.map(c => h('th', {}, c.label)))), h('tbody', {}, rows.length ? rows.map(row => h('tr', { class: onRow ? 'clickable' : '', onClick: onRow ? () => onRow(row) : undefined }, columns.map(c => h('td', {}, c.render ? c.render(row) : row[c.key] ?? '—')))) : h('tr', {}, h('td', { colSpan: columns.length, class: 'table-empty' }, icon('file', 25), h('p', {}, empty)))))); }
export function empty(title, description, action) { return h('div', { class: 'empty-state' }, h('div', { class: 'empty-icon' }, icon('box', 27)), h('h3', {}, title), h('p', {}, description), action); }
export function toast(message, kind = 'success') { const node = h('div', { class: 'toast ' + kind, role: 'status' }, icon(kind === 'success' ? 'check' : 'activity'), h('span', {}, message));const container=document.querySelector('#toasts');container.append(node);while(container.children.length>3)container.firstElementChild.remove();setTimeout(() => node.remove(), 4500); }
let fieldId = 0;
export function field(label, control, hint) { control.id ||= 'field-' + (++fieldId); return h('div', { class: 'field' }, h('label', { htmlFor: control.id }, label), control, hint ? h('p', { class: 'field-hint' }, hint) : null); }
export function select(options, value, onChange, extra = {}) { return h('select', { value, onChange, ...extra }, options.map(o => h('option', { value: typeof o === 'string' ? o : o.value, disabled: o.disabled ?? false }, typeof o === 'string' ? o : o.label))); }
export function checklist(options, selected = []) { return h('div', { class: 'checklist' }, options.length ? options.map(o => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', value: o.value, checked: selected.includes(o.value), disabled: o.disabled ?? false }), h('span', {}, h('strong', {}, o.label), o.hint ? h('small', {}, o.hint) : null))) : h('p', { class: 'muted' }, '暂无可配置的能力')); }
export const checked = node => [...node.querySelectorAll('input:checked')].map(n => n.value);
export function modal(title, description, body, onSave, { saveLabel = '保存', wide = false, danger = false } = {}) {
    const dialog = h('dialog', { class: 'modal' + (wide ? ' modal-wide' : '') });
    const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const save = h('button', { type: 'submit', class: 'button ' + (danger ? 'danger' : 'primary') }, saveLabel);
    const form = h('form', { onSubmit: async (event) => { event.preventDefault(); save.disabled = true; save.textContent = '处理中…'; error.hidden = true; try {
            await onSave?.();
            dialog.close();
        }
        catch (e) {
            error.textContent = e.message;
            error.hidden = false;
            error.scrollIntoView({ block: 'nearest' });
        }
        finally {
            save.disabled = false;
            save.textContent = saveLabel;
        } } }, h('header', { class: 'modal-header' }, h('div', {}, h('h2', {}, title), h('p', {}, description)), button(icon('x'), () => dialog.close(), 'icon-button', { 'aria-label': '关闭弹窗' })), h('div', { class: 'modal-body' }, body, error), h('footer', { class: 'modal-footer' }, button('取消', () => dialog.close()), onSave ? save : button('关闭', () => dialog.close(), 'primary')));
    dialog.append(form);
    dialog.addEventListener('click', e => { if (e.target === dialog && e.offsetX < 0)
        dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
}
export function confirm(title, description, action, label = '确认') { return modal(title, description, h('div', { class: 'notice warning' }, icon('shield'), h('span', {}, description)), action, { saveLabel: label, danger: true }); }
export function details(title, data) { modal(title, '仅展示当前账号获准查看的记录。', h('pre', { class: 'json-detail' }, JSON.stringify(data, null, 2)), null, { wide: true }); }
export function searchInput(placeholder, onInput) { return h('div', { class: 'search-box' }, icon('search'), h('input', { type: 'search', placeholder, 'aria-label': placeholder, onInput })); }
export function heading(title, description, action) { return h('div', { class: 'page-heading' }, h('div', {}, h('h1', {}, title), h('p', {}, description)), action); }
// One lifecycle per rendered view. Polls never rebuild its filters or editor.
export function liveRefresh(ctx, read, blocked = () => '') {
    const label = h('span', { class: 'count-label', role: 'status', 'aria-live': 'off', 'data-live-status': '' }, '自动更新 · 每3秒');
    let timer, pending, disposed = false, started = false, failures = 0;
    const active = () => !disposed && ctx.isCurrent?.() !== false;
    const schedule = () => { clearTimeout(timer); if (active() && started) timer = setTimeout(refresh, Math.min(30000, 3000 * 2 ** failures)); };
    function refresh() {
        if (!active()) return Promise.resolve();
        if (pending) return pending;
        const reason = blocked() || (document.querySelector('dialog[open]') ? '对话框操作中' : '');
        if (document.hidden || reason) {
            label.textContent = reason ? reason + ' · 自动更新暂停' : '页面未显示 · 返回后自动更新';
            schedule(); return Promise.resolve();
        }
        clearTimeout(timer);
        pending = (async () => {
            try {
                const applied = await read();
                if (!active()) return;
                failures = 0;
                label.textContent = applied === false ? '编辑或选择已变化 · 稍后自动更新' : '自动更新 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
            } catch (error) {
                if (!active()) return;
                if (['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(error.code)) { ctx.sessionExpired?.(error); return; }
                failures = Math.min(failures + 1, 4);
                label.textContent = '连接暂不可用 · 保留当前内容，稍后重试';
            } finally { pending = undefined; schedule(); }
        })();
        return pending;
    }
    const resume = () => { if (!document.hidden) void refresh(); };
    const controller = {
        refresh,
        start() { if (started || disposed) return; started = true; document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume); schedule(); },
        dispose() { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); }
    };
    ctx.registerLive?.(controller);
    return label;
}
export function panel(title, description, content, action) { return h('section', { class: 'panel' }, h('div', { class: 'panel-heading' }, h('div', {}, h('h2', {}, title), description ? h('p', {}, description) : null), action), content); }
export function metric(label, value, caption, name) { return h('article', { class: 'metric' }, h('div', { class: 'metric-top' }, h('span', {}, label), h('span', { class: 'metric-icon' }, icon(name))), h('strong', { class: 'metric-value' }, number(value)), h('span', { class: 'metric-caption' }, caption)); }
export function chart(series) { const width = 720, height = 188, pad = 18; const values = series.map(s => s.inputTokens + s.outputTokens); const max = Math.max(...values, 1); const points = values.map((v, i) => [pad + i * (width - pad * 2) / Math.max(values.length - 1, 1), height - pad - v / max * (height - pad * 2)]); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '每日模型 Token 使用量'); for (const ratio of [0, .5, 1]) {
    const line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', pad);
    line.setAttribute('x2', width - pad);
    line.setAttribute('y1', pad + ratio * (height - pad * 2));
    line.setAttribute('y2', pad + ratio * (height - pad * 2));
    line.setAttribute('class', 'chart-grid');
    svg.append(line);
} const area = document.createElementNS(svg.namespaceURI, 'path'); area.setAttribute('d', `M${pad},${height - pad} L${points.map(p => p.join(',')).join(' L')} L${width - pad},${height - pad} Z`); area.setAttribute('class', 'chart-area'); svg.append(area); const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', points.map(p => p.join(',')).join(' ')); line.setAttribute('class', 'chart-line'); svg.append(line); points.forEach((point, i) => { const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx', point[0]); dot.setAttribute('cy', point[1]); dot.setAttribute('r', 3); dot.setAttribute('class', 'chart-dot'); const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${series[i].day}：${number(values[i])} tokens`; dot.append(title); svg.append(dot); }); const interval = Math.max(1, Math.floor(series.length / 7)); return h('div', { class: 'chart' }, h('div', { class: 'chart-scale' }, h('span', {}, number(max)), h('span', {}, 'TOKENS')), svg, h('div', { class: 'chart-labels' }, series.filter((_, i) => i % interval === 0 || i === series.length - 1).map(s => h('span', {}, s.day.slice(5).replace('-', '/'))))); }
