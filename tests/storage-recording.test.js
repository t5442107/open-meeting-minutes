const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../lib/store');
const { Recording } = require('../lib/recording');
const { simplifyMeetingNotes } = require('../lib/simplified-chinese');
const { BALANCE_URL, fetchDeepSeekBalance } = require('../lib/deepseek-balance');
const { buildMeetingPosterPages, parseNotes } = require('../lib/meeting-poster');

test('meeting poster parsing preserves plain text and Markdown heading bodies', () => {
  assert.deepEqual(parseNotes('第一行正文\n第二行正文'), [{ title: '会议纪要', paragraphs: ['第一行正文', '第二行正文'] }]);
  assert.deepEqual(parseNotes('## 只有标题'), [{ title: '只有标题', paragraphs: [] }]);
  const pages = buildMeetingPosterPages({ title: '示例', summary: '摘要', notes: '## 结论\n先定方案。\n\n## 讨论\n保留正文第一行。\n第二行正文。\n\n## 待确认\n重复标题下的内容。', highlights: [], todos: [] });
  const html = pages.join('');
  for (const text of ['先定方案。', '保留正文第一行。', '第二行正文。', '重复标题下的内容。']) assert.ok(html.includes(text));
  assert.equal((html.match(/class="section orange"/g) || []).length, 1);
  assert.ok(html.includes('<h3>结论</h3>') && html.includes('<h3>讨论</h3>') && html.includes('<h3>待确认</h3>'));
});

test('meeting poster escapes HTML supplied in meeting text', () => {
  const [html] = buildMeetingPosterPages({ title: '<img src=x onerror=alert(1)>', summary: '<script>bad()</script>', notes: '## 讨论\nA & B < C', highlights: [], todos: [] });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(html.includes('A &amp; B &lt; C'));
  assert.equal(html.includes('<script>bad()'), false);
});

test('meeting poster supports a custom image title without changing other meeting content', () => {
  const [html] = buildMeetingPosterPages({ title: '图片专用标题', summary: '原会议摘要', notes: '', highlights: [], todos: [] });
  assert.match(html, /图片专用标题/);
  assert.match(html, /原会议摘要/);
});

test('meeting poster paginates long content and rejects only beyond the bounded total', () => {
  const longSummary = '摘要续页内容需要保留。'.repeat(100);
  const summaryPages = buildMeetingPosterPages({ title: '长摘要', summary: longSummary, notes: '', highlights: [], todos: [] });
  assert.ok(summaryPages.join('').includes(longSummary.slice(0, 80)));
  assert.ok(summaryPages.join('').includes(longSummary.slice(-80)));

  const text = '长内容完整保留。'.repeat(1800);
  const pages = buildMeetingPosterPages({ title: '分页会议', summary: '概述', notes: `## 讨论\n${text}`, highlights: [], todos: [] });
  assert.ok(pages.length > 1);
  const combined = pages.join('');
  assert.ok(combined.includes(text.slice(0, 100)));
  assert.ok(combined.includes(text.slice(-100)));
  assert.throws(() => buildMeetingPosterPages({ summary: 'x'.repeat(200001), notes: '' }), /文字量过大/);
});

test('DeepSeek balance uses the official endpoint and returns account fields through a local mock', async () => {
  let request;
  const result = await fetchDeepSeekBalance('mock-secret', async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00', granted_balance: '2.00', topped_up_balance: '8.00' }] }) };
  });
  assert.equal(request.url, BALANCE_URL);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer mock-secret');
  assert.deepEqual(result, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00', granted_balance: '2.00', topped_up_balance: '8.00' }] });
  await assert.rejects(fetchDeepSeekBalance('', async () => { throw new Error('should not fetch'); }), /配置 DeepSeek API 密钥/);
});

test('AI meeting note text is converted to Simplified Chinese without changing English or numbers', () => {
  const result = simplifyMeetingNotes({
    summary: '會議確認 API v2 於 2025 年上線',
    minutes: '## 決議\n確認後續計畫。',
    highlights: ['產品負責人 Alice 將跟進'],
    todos: [{ title: '確認專案時程', owner: '張先生', due: '下週一 10:30' }],
  });
  assert.equal(result.summary, '会议确认 API v2 于 2025 年上线');
  assert.equal(result.minutes, '## 决议\n确认后续计划。');
  assert.equal(result.highlights[0], '产品负责人 Alice 将跟进');
  assert.deepEqual(result.todos[0], { title: '确认专案时程', owner: '张先生', due: '下周一 10:30' });
});

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.init(); return { root, store };
}
test('serialized edits preserve unrelated fields and search full transcript', async t => {
  const { store } = await workspace(t);
  const meeting = await store.save({ title: '采购复盘', transcript: '供应商交期从十月延至十一月', todos: [] });
  await Promise.all([store.save({ id: meeting.id, notes: '确认交期' }), store.save({ id: meeting.id, speakerNames: { speaker_1: '小陈' } })]);
  const latest = await store.get(meeting.id);
  assert.equal(latest.notes, '确认交期'); assert.equal(latest.speakerNames.speaker_1, '小陈');
  assert.equal((await store.list({ query: '供应商 十一月' }))[0].id, meeting.id);
  assert.equal((await store.list({ query: '不存在的词' })).length, 0);
  await assert.rejects(store.get('../escape'));
});
test('legacy migration preserves notes and existing settings across launches', async t => {
  const { root } = await workspace(t);
  await fs.writeFile(path.join(root, 'huiyi-data.json'), JSON.stringify({ config: { endpoint: 'http://localhost:1234/v1' }, meetings: [{ id: 'old-1', title: '旧会', notes: '旧纪要' }] }));
  const store = new Store(root); await store.init();
  assert.equal((await store.get('old-1')).notes, '旧纪要');
  assert.equal((await store.settings()).config.endpoint, 'http://localhost:1234/v1');
  await store.save({ id: 'old-1', notes: '修改后的纪要' }); await store.init();
  assert.equal((await store.get('old-1')).notes, '修改后的纪要');
});
test('删除会议会清除整条会议目录并阻止 legacy 数据在重启迁回', async t => {
  const { root, store } = await workspace(t);
  const deletedId = 'legacy-deleted', keptId = 'keep-me';
  await fs.writeFile(path.join(root, 'huiyi-data.json'), JSON.stringify({ meetings: [{ id: deletedId, title: '旧会议' }, { id: keptId, title: '保留会议' }] }));
  await store.init();
  await fs.mkdir(path.join(store.meetingDir(deletedId), 'chunks'), { recursive: true });
  await fs.writeFile(path.join(store.meetingDir(deletedId), 'recording.wav'), 'audio');
  await fs.writeFile(path.join(store.meetingDir(deletedId), 'chunks', 'part.pcm'), 'chunk');
  await store.deleteMeeting(deletedId);
  await assert.rejects(fs.access(store.meetingDir(deletedId)));
  await assert.rejects(store.get(deletedId));
  await assert.rejects(store.save({ id: deletedId, notes: '不应复活' }), /已删除/);
  const restarted = new Store(root); await restarted.init();
  assert.deepEqual((await restarted.list({})).map(item => item.id), [keptId]);
  await assert.rejects(restarted.get(deletedId));
});
test('删除会议拒绝符号链接目录', async t => {
  const { root, store } = await workspace(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'meetings', 'linked'));
  await fs.rm(path.join(root, 'meetings', 'linked'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'meetings', 'linked'));
  await assert.rejects(store.deleteMeeting('linked'), /路径无效/);
  assert.equal((await fs.lstat(outside)).isDirectory(), true);
});
test('文件删除失败时会议仍可见并可重试删除', async t => {
  const { store } = await workspace(t);
  const meeting = await store.save({ title: '可重试删除', notes: '保留到重试成功' });
  const remove = store.removeMeetingDirectory;
  store.removeMeetingDirectory = async () => { throw new Error('模拟文件占用'); };
  await assert.rejects(store.deleteMeeting(meeting.id), /可重试/);
  assert.equal((await store.get(meeting.id)).notes, '保留到重试成功');
  assert.equal((await store.list({}))[0].id, meeting.id);
  store.removeMeetingDirectory = remove;
  await store.deleteMeeting(meeting.id);
  assert.equal((await store.list({})).length, 0);
  const restarted = new Store(store.root); await restarted.init();
  assert.equal((await restarted.list({})).length, 0);
});
test('PCM recording persists exact samples and overlapping chunk timestamps', async t => {
  const { store } = await workspace(t), commands = [];
  const meeting = await store.save({ title: '录音测试', status: 'recording' });
  const recording = new Recording({ meeting, store, engine: { send: command => commands.push(command) }, language: 'zh', onEvent: () => {} });
  await recording.open();
  const pcm = Buffer.alloc(32000 * 25);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE((i % 100) * 100, i * 2);
  for (let offset = 0; offset < pcm.length; offset += 8192) recording.append(pcm.subarray(offset, offset + 8192));
  const result = await recording.finish(), wav = await fs.readFile(result.path);
  assert.equal(result.duration, 25); assert.equal(wav.readUInt32LE(40), pcm.length); assert.deepEqual(wav.subarray(44), pcm);
  assert.equal(commands.length, 3); assert.deepEqual(commands.map(command => command.offset), [0, 7, 14]);
  const second = await fs.readFile(commands[1].path);
  assert.deepEqual(second.subarray(44), pcm.subarray(32000 * 7, 32000 * 15));
  const third = await fs.readFile(commands[2].path);
  assert.deepEqual(third.subarray(44), pcm.subarray(32000 * 14, 32000 * 22));
});
