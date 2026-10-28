const MAX_TEXT_CHARS = 200000;
const MAX_PAGES = 20;
const PAGE_BUDGET = 4500;

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function splitText(text, limit = 1200) {
  const chars = Array.from(String(text || ''));
  const pieces = [];
  for (let i = 0; i < chars.length; i += limit) pieces.push(chars.slice(i, i + limit).join(''));
  return pieces.length ? pieces : [''];
}
function parseNotes(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/), groups = [];
  let current = { title: '会议纪要', paragraphs: [] };
  for (const raw of lines) {
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (current.paragraphs.length || (groups.length === 0 && current.title !== '会议纪要')) groups.push(current);
      current = { title: heading[1].trim(), paragraphs: [] };
      continue;
    }
    const line = raw.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
    if (line) current.paragraphs.push(line);
  }
  if (current.paragraphs.length || !groups.length) groups.push(current);
  return groups;
}
function categorize(title) {
  if (/待办|行动|下一步|任务/.test(title)) return 'pink';
  if (/结论|决定|决策|讨论|待确认|风险|问题/.test(title)) return 'orange';
  return 'green';
}
function makeSections(meeting) {
  const summary = String(meeting.summary || '').trim();
  const summaryParts = splitText(summary, 900);
  const headlineSummary = summaryParts.shift() || '';
  const sections = [];
  const appendSection = section => {
    const previous = sections.at(-1);
    if (previous?.tone === section.tone && previous.kind === section.kind) previous.cards.push(...section.cards);
    else sections.push({ ...section, title: ({ blue: '会议重点', orange: '结论与讨论', pink: '下一步行动', green: '详细纪要' })[section.tone] || section.title });
  };
  const highlights = (Array.isArray(meeting.highlights) ? meeting.highlights : []).filter(x => typeof x === 'string' && x.trim());
  if (highlights.length) appendSection({ tone: 'blue', title: '会议重点', kind: 'cards', cards: highlights.flatMap(text => splitText(text.trim()).map((part, n) => ({ title: n ? '重点续篇' : '重点', body: [part] }))) });
  if (summaryParts.length) appendSection({ tone: 'blue', title: '摘要续篇', kind: 'cards', cards: summaryParts.map(body => ({ title: '摘要', body: [body] })) });
  for (const group of parseNotes(meeting.notes)) {
    const tone = categorize(group.title);
    const paragraphs = group.paragraphs.flatMap(body => splitText(body));
    const cards = [];
    let body = [];
    for (const paragraph of paragraphs) {
      if (body.join('').length + paragraph.length > 1800 && body.length) { cards.push({ title: group.title, body }); body = []; }
      body.push(paragraph);
    }
    if (body.length) cards.push({ title: group.title, body });
    if (!cards.length && group.title) cards.push({ title: group.title, body: [] });
    if (cards.length) appendSection({ tone, title: group.title, kind: 'cards', cards });
  }
  const todos = (Array.isArray(meeting.todos) ? meeting.todos : []).filter(t => t && typeof t.title === 'string' && t.title.trim()).flatMap(t => splitText(t.title.trim()).map((title, i) => ({ title, owner: i ? '' : String(t.owner || '待确认'), due: i ? '' : String(t.due || '待确认'), done: i ? false : !!t.done })));
  if (todos.length) appendSection({ tone: 'pink', title: '下一步行动', kind: 'todos', cards: todos });
  return { summary: headlineSummary, sections };
}
function estimate(card, kind) { return kind === 'todos' ? 140 + Math.ceil((card.title.length + card.owner.length + card.due.length) / 42) * 27 : 170 + Math.ceil(card.body.join('').length / 43) * 29 + card.body.length * 30; }
function paginate(sections) {
  const pages = [];
  let page = [], used = 0;
  const addPage = () => { if (page.length) pages.push(page); page = []; used = 0; };
  for (const section of sections) {
    const headingCost = 100;
    let segment = { ...section, cards: [] };
    for (const card of section.cards) {
      const cost = estimate(card, section.kind);
      if (used && used + cost + (segment.cards.length ? 0 : headingCost) > PAGE_BUDGET) {
        if (segment.cards.length) page.push(segment);
        addPage();
        segment = { ...section, cards: [] };
      }
      if (!segment.cards.length) used += headingCost;
      segment.cards.push(card); used += cost;
    }
    if (segment.cards.length) page.push(segment);
  }
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}
function markup(meeting, sections, summary, pageIndex, pageCount) {
  const meta = `${meeting.date ? new Date(meeting.date).toLocaleDateString('zh-CN') : ''}${meeting.duration ? `　·　${Math.max(1, Math.round(Number(meeting.duration) / 60))} 分钟` : ''}`;
  const renderBody = text => {
    const match = String(text || '').match(/^([^：:]{1,24}[：:])(.*)$/s);
    return match ? `<b>${escapeHtml(match[1])}</b>${escapeHtml(match[2])}` : escapeHtml(text || '');
  };
  const renderCard = (card, kind) => kind === 'todos'
    ? `<article class="todo ${card.done ? 'is-done' : ''}"><span class="step">${card.done ? '✓' : '○'}</span><div class="todo-inner"><h3>${escapeHtml(card.title)}</h3><div class="todo-copy"><p><b>状态：</b>${card.done ? '已完成' : '待完成'}</p><p><b>负责人：</b>${escapeHtml(card.owner || '待确认')}</p><p><b>时间：</b>${escapeHtml(card.due || '待确认')}</p></div></div></article>`
    : `<article class="card"><header><span class="tile-icon">✦</span><h3>${escapeHtml(card.title || '内容')}</h3></header><div class="card-inner">${card.body.map(body => `<p><i>•</i>${renderBody(body)}</p>`).join('')}</div></article>`;
  const rendered = sections.map(section => `<section class="section ${section.tone}"><div class="section-head"><span class="spark">✣</span><h2>${escapeHtml(section.title)}</h2></div><div class="grid ${section.kind === 'todos' ? 'timeline' : ''}">${section.cards.map(card => renderCard(card, section.kind)).join('')}</div></section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head><style>
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#242832;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}#poster{width:1080px;padding:58px 70px 66px;margin:auto;background:#fff}.hero{padding-bottom:26px;border-bottom:1px solid #e9ebef}.hero h1{font-size:38px;line-height:1.3;margin:0 0 10px;font-weight:850;letter-spacing:-.5px;overflow-wrap:anywhere}.summary{font-size:20px;line-height:1.62;color:#565d69;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.meta{margin-top:16px;color:#939aa5;font-size:15px}.page{float:right;color:#a3a8b0;font-size:14px;font-weight:600}.section{margin-top:34px;break-inside:avoid}.section-head{display:flex;align-items:center;gap:11px;margin-bottom:16px}.spark{font-size:25px;font-weight:900}.section-head h2{font-size:27px;line-height:1.3;margin:0;font-weight:850;overflow-wrap:anywhere}.blue .spark,.blue h2{color:#397be8}.orange .spark,.orange h2{color:#e89138}.pink .spark,.pink h2{color:#df6e92}.green .spark,.green h2{color:#23a596}.grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.card{min-width:0;border-radius:18px;padding:16px;background:#eaf2ff;break-inside:avoid}.orange .card{background:#fff1e3}.green .card{background:#e6f7f4}.card:last-child:nth-child(odd){grid-column:1/-1}.card header{display:flex;align-items:center;gap:9px;margin:0 1px 12px}.tile-icon{display:grid;place-items:center;width:25px;height:25px;border-radius:8px;background:#d6e6ff;color:#397be8;font-size:14px}.orange .tile-icon{background:#ffe3c4;color:#df862a}.green .tile-icon{background:#cdefe9;color:#1a9d8e}.card h3{font-size:19px;line-height:1.35;margin:0;font-weight:800;color:#20242c;overflow-wrap:anywhere}.card-inner{background:#fff;border-radius:12px;padding:14px 16px;min-height:54px}.card-inner p{font-size:17px;line-height:1.58;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.card-inner p+p{margin-top:8px}.card-inner p i{font-style:normal;color:#397be8;font-weight:900;margin-right:9px}.orange .card-inner p i{color:#df862a}.green .card-inner p i{color:#1a9d8e}.card-inner p b{color:#397be8}.orange .card-inner p b{color:#df862a}.green .card-inner p b{color:#1a9d8e}.timeline{display:block;border-radius:19px;padding:11px 17px;background:#fff0f5}.todo{position:relative;display:flex;gap:13px;padding:11px 5px;break-inside:avoid}.todo:not(:last-child):after{content:"";position:absolute;left:20px;top:43px;bottom:-5px;border-left:2px dashed #e8a3b6}.step{z-index:1;flex:0 0 30px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;background:#df7393;font-weight:800}.todo.is-done .step{background:#7ab99f}.todo.is-done h3{text-decoration:line-through;color:#77827b}.todo-inner{background:#fff;border-radius:13px;padding:12px 15px;flex:1;min-width:0}.todo h3{font-size:18px;line-height:1.45;margin:0 0 7px;overflow-wrap:anywhere}.todo-copy{display:flex;gap:22px;flex-wrap:wrap}.todo-copy p{margin:0;font-size:14px;color:#737b86;overflow-wrap:anywhere}.todo-copy b{color:#d9698a}
</style><body><main id="poster"><header class="hero"><span class="page">${pageCount > 1 ? `第 ${pageIndex + 1} / ${pageCount} 页` : ''}</span><h1>${escapeHtml(meeting.title || '会议纪要')}</h1><p class="summary">${escapeHtml(summary)}</p><div class="meta">${escapeHtml(meta)}</div></header>${rendered}</main></body></html>`;
}
function buildMeetingPosterPages(meeting) {
  const allText = [meeting.title, meeting.summary, meeting.notes, ...(meeting.highlights || []), ...(meeting.todos || []).map(t => `${t.title}${t.owner}${t.due}`)].join('');
  if (Array.from(allText).length > MAX_TEXT_CHARS) throw new Error('纪要文字量过大，请先精简内容后再生成图片。');
  const data = makeSections(meeting);
  const pages = paginate(data.sections);
  if (pages.length > MAX_PAGES) throw new Error(`纪要内容较长，需 ${pages.length} 张图片（最多支持 ${MAX_PAGES} 张）；请精简后重试。`);
  return pages.map((sections, index) => markup(meeting, sections, index === 0 ? data.summary : '', index, pages.length));
}
module.exports = { buildMeetingPosterPages, parseNotes, paginate };
