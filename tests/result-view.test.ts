import { test, expect } from 'vitest';
import { readableText } from '../client/web/result-view.mjs';
test('employee result text keeps facts and amounts while technical identifiers stay out of the reading layer', () => {
    const raw = '**拟处理结果**：测试文案已规范化，金额 2380.50 元。\n- 工具：`@example/conformance:text.normalize`\n- invocationId `e9f7ea6a-35c5-425f-a5e2-886e574374de`，evidenceRefs `97220603-0800-42b2-90f2-f08e03bd3fb3`\n- 状态：succeeded；待处理：人工核对';
    const text = readableText(raw);
    expect(text).toContain('测试文案已规范化'); expect(text).toContain('2380.50'); expect(text).toContain('人工核对');
    expect(text).not.toMatch(/e9f7ea6a|97220603|@example|invocationId|evidenceRefs|succeeded/u);
});
test('reading a result never replaces ordinary amounts, short identifiers or quoted business words with employee names', () => {
    const original='费用为 1000 元，客户代号 bobcat。产品术语 succeeded 保持原样。';
    expect(readableText(original,{'1000':'财务同事',bob:'销售同事'})).toBe(original);
});
