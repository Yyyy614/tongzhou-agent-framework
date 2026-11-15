import { api } from './api.js';
import { h, button, modal, field, toast, date, badge } from './ui.js';

export function employeeAccess(ctx, employee) {
    const assigned = ctx.agents.filter(a => a.ownerId === employee.id && a.active && a.runtime !== 'remote' && a.preset);
    const code = h('input', { type: 'password', readOnly: true, autocomplete: 'off', placeholder: '点击下方按钮生成，仅本次显示', 'aria-label': '一次性激活码' });
    const result = h('p', { class: 'field-hint' }, '激活码有效期 24 小时，只能用于一台电脑。重新签发会作废该员工之前尚未使用的码。');
    const devices = h('div', {}, h('p', { class: 'muted' }, '正在读取设备…'));
    const failure = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    async function run(action) { failure.hidden = true; try { await action(); } catch (e) { failure.textContent = e.message; failure.hidden = false; } }
    async function load() {
        const rows = await api('/v1/admin/employees/' + encodeURIComponent(employee.id) + '/devices');
        devices.replaceChildren(...(rows.length ? rows.map(row => h('div', { class: 'notice space-top' }, h('div', {}, h('strong', {}, row.name), h('p', { class: 'field-hint' }, '激活于 ' + date(row.createdAt) + ' · 有效至 ' + date(row.expiresAt))), row.revokedAt ? badge('已撤销', 'neutral') : button('撤销此设备', () => { if (confirm('撤销后此设备的后续请求会被拒绝，确定继续吗？')) void run(async () => { await api('/v1/admin/employees/' + encodeURIComponent(employee.id) + '/devices/' + row.id, 'DELETE'); await load(); }); }, 'text'))) : [h('p', { class: 'muted' }, '尚无激活设备') ]));
    }
    const create = button('生成一次性激活码', () => { void run(async () => { create.disabled = true; try { const invitation = await api('/v1/admin/employees/' + encodeURIComponent(employee.id) + '/invitations', 'POST', {}); code.value = invitation.code; result.textContent = '有效至 ' + date(invitation.expiresAt) + '；只显示本次结果，请交给该员工。'; } finally { create.disabled = false; } }); }, 'primary', { disabled: !employee.active || !assigned.length });
    const body = h('div', {}, h('div', { class: 'notice' }, h('span', {}, assigned.length ? '已分配：' + assigned.map(a => a.displayName ?? a.id).join('、') : '请先创建并启用该员工的 Harness Agent，选择岗位预设、插件和权限。')), h('p', {}, '登录账号：' + employee.id), field('一次性激活码', code), result, h('div', { class: 'button-row' }, create, button('复制激活码', async () => { if (!code.value) return; await navigator.clipboard.writeText(code.value); toast('已复制，请仅交给对应员工'); }), button('显示 / 隐藏', () => { code.type = code.type === 'password' ? 'text' : 'password'; })), h('p', { class: 'field-hint space-top' }, '员工首次在客户端选择“首次接入 / 重置密码”，使用此码设置自己的密码。之后在其他电脑用账号密码登录。重新设置密码会退出该员工之前的设备。客户端不含管理员或模型总密钥。'), h('a', { href: '/v1/admin/employee-client', class: 'button secondary', download: 'CompanyAgent-windows-x64.zip' }, '下载员工客户端'), h('h3', {}, '已登录的电脑'), devices, button('刷新设备', () => { void run(load); }), failure);
    const dialog = modal('员工接入 · ' + (employee.displayName ?? employee.id), '分配完成后，用一次性激活码把员工与其电脑绑定。', body, null, { wide: true });
    dialog.addEventListener('close', () => { code.value = ''; });
    void run(load);
}
