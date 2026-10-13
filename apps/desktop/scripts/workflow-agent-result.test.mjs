import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentResultValue } from '../src/lib/workflowAgentResult.ts';

test('ordinary answers and ambiguous prose remain exact text', () => {
  for (const text of ['  普通回答\n第二段  ', 'A｜B', '开场\nA｜B\n1｜2\n末尾说明', 'A｜B\n1｜2｜3', 'A｜B\n1｜2\n\nC｜D\n3｜4', '{"name":"普通 JSON"}']) {
    assert.deepEqual(agentResultValue(text), { type: 'text', text });
  }
});

test('the supplied full-width table becomes seven columns with a separate title', () => {
  const text = '■ 主框架｜10 屏在五段叙事中的位置\n序号｜屏次｜模块｜风格｜主标题｜文案｜收束\n1｜1｜写螺｜轻叙图鉴｜紫心宝螺，天然釉光如珀。｜壳形圆润，表面光滑温润。｜光落其上，繁意自生。\n2｜2｜挑一｜轻叙式｜万贝过眼，只取一枚好紫。｜卡尺量尺寸，灯下辨色泽。｜挑一，是成饰之前的郑重。';
  const value = agentResultValue(text);
  assert.equal(value.table.title, '主框架｜10 屏在五段叙事中的位置');
  assert.equal(value.table.rows[0].length, 7);
  assert.equal(value.table.rows.length, 3);
  assert.equal(value.table.rows[2][4], '万贝过眼，只取一枚好紫。');
  assert.deepEqual(JSON.parse(value.text).rows, value.table.rows);
});

test('Markdown tables preserve empty cells, escaped delimiters, and line breaks', () => {
  const value = agentResultValue('# 文案\n| 模块 | 文案 |\n| :--- | ---: |\n| 写螺 | 紫色\\|光泽<br>第二行 |\n| 挑一 | |');
  assert.deepEqual(value.table, { title: '文案', rows: [['模块', '文案'], ['写螺', '紫色|光泽\n第二行'], ['挑一', '']] });
  assert.equal(agentResultValue('字段\t说明\n名称\t宝螺').table.rows[1][1], '宝螺');
  assert.deepEqual(agentResultValue('字段\t说明\n名称\t').table.rows, [['字段', '说明'], ['名称', '']]);
  assert.deepEqual(agentResultValue('字段｜说明\n名称｜').table.rows, [['字段', '说明'], ['名称', '']]);
});

test('explicit structured results preserve arbitrary cell text and reject malformed tables', () => {
  const table = { format: 'bowerbird-table', title: '主框架', columns: ['模块', '文案'], rows: [['写螺', '第一行\n第二行｜保留'], ['挑一', '']] };
  const value = agentResultValue(JSON.stringify(table));
  assert.deepEqual(value.table.rows, [table.columns, ...table.rows]);
  assert.equal(JSON.parse(value.text).rows[1][1], '第一行\n第二行｜保留');
  assert.equal(agentResultValue('```json\n' + JSON.stringify(table) + '\n```').table.title, '主框架');
  for (const invalid of [{ ...table, rows: [['少一列']] }, { ...table, columns: [] }, { ...table, rows: [[1, 2]] }, { ...table, rows: [] }, { ...table, extra: true }]) {
    assert.throws(() => agentResultValue(JSON.stringify(invalid)), /表格/);
  }
  assert.throws(() => agentResultValue('x'.repeat(16001)), /16000/);
});

test('canonical tables can roundtrip a single cell or a headerless grid without inventing rows', () => {
  for (const rows of [[['一格\n两行']], [['', ''], ['a|b', '"原文"']], [['标题', '内容'], ['1', '']]]) {
    const source = { format: 'bowerbird-table', rows };
    const value = agentResultValue(JSON.stringify(source));
    assert.deepEqual(value.table, { rows });
    assert.deepEqual(JSON.parse(value.text), source);
  }
  for (const rows of [[], [[]], [['a'], ['a', 'b']], [[1]], ['bad']]) {
    assert.throws(() => agentResultValue(JSON.stringify({ format: 'bowerbird-table', rows })), /表格/);
  }
});
