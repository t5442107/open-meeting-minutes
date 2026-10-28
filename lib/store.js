const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class Store {
  constructor(root) { this.root = root; this.tail = Promise.resolve(); this.removeMeetingDirectory = dir => fs.rm(dir, { recursive: true, force: false }); }
  meetingDir(id) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('会议编号无效');
    return path.join(this.root, 'meetings', id);
  }
  async init() {
    await fs.mkdir(path.join(this.root, 'meetings'), { recursive: true });
    this.deletedIds = new Set(); this.pendingDeleteIds = new Set();
    try {
      const deleted = JSON.parse(await fs.readFile(path.join(this.root, 'deleted-meetings.json'), 'utf8'));
      for (const id of deleted.ids || []) if (/^[a-zA-Z0-9-]{1,100}$/.test(id)) this.deletedIds.add(id);
      for (const id of deleted.pending || []) if (/^[a-zA-Z0-9-]{1,100}$/.test(id)) this.pendingDeleteIds.add(id);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('已删除会议记录无法读取。'); }
    // Finish deletions interrupted after the durable pending marker was written.
    let recoveredDeletion = false;
    for (const id of [...this.pendingDeleteIds]) {
      try { await fs.lstat(this.meetingDir(id)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.pendingDeleteIds.delete(id); this.deletedIds.add(id); recoveredDeletion = true;
      }
    }
    if (recoveredDeletion) await this.writeDeletionState();
    let legacy;
    try { legacy = JSON.parse(await fs.readFile(path.join(this.root, 'huiyi-data.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('旧会议数据无法读取，请保留原数据文件并检查格式。'); }
    if (legacy) {
      const settingsFile = path.join(this.root, 'settings.json');
      try { await fs.access(settingsFile); }
      catch { await this.atomic(settingsFile, { config: legacy.config || {}, encryptedKey: legacy.encryptedKey }); }
      for (const item of legacy.meetings || []) {
        const id = /^[a-zA-Z0-9-]{1,100}$/.test(item.id || '') ? item.id : randomUUID();
        if (this.deletedIds.has(id)) continue;
        const filename = path.join(this.meetingDir(id), 'meeting.json');
        try { await fs.access(filename); }
        catch { await this.save({ ...item, id, status: 'completed' }); }
      }
    }
    // A terminated process must not leave a meeting permanently appearing live.
    for (const item of await this.list({})) {
      if (['preparing', 'recording', 'refining'].includes(item.status)) await this.save({ id: item.id, status: 'interrupted', warning: '上次处理被中断。已保留录音和已有转写，可以重新处理。' });
    }
  }
  async atomic(filename, value) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      const delays = [40, 80, 160, 320, 640];
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temporary, filename);
          return;
        } catch (error) {
          const transientWindowsLock = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
          if (!transientWindowsLock || attempt >= delays.length) throw error;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    } catch (error) {
      try { await fs.rm(temporary, { force: true }); } catch {}
      throw error;
    }
  }
  async writeDeletionState() {
    await this.atomic(path.join(this.root, 'deleted-meetings.json'), { ids: [...this.deletedIds], pending: [...this.pendingDeleteIds] });
  }
  async get(id) {
    if (this.deletedIds?.has(id)) throw new Error('这条会议记录已删除');
    return JSON.parse(await fs.readFile(path.join(this.meetingDir(id), 'meeting.json'), 'utf8'));
  }
  save(change) {
    const operation = this.tail.then(async () => {
      const id = change.id || randomUUID();
      if (this.deletedIds?.has(id)) throw new Error('这条会议记录已删除');
      let existing = {};
      try { existing = await this.get(id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const meeting = { id, date: new Date().toISOString(), title: '未命名会议', segments: [], speakerNames: {}, todos: [], ...existing, ...change, id, updatedAt: new Date().toISOString() };
      await this.atomic(path.join(this.meetingDir(id), 'meeting.json'), meeting);
      return meeting;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  deleteMeeting(id) {
    const operation = this.tail.then(async () => {
      if (this.deletedIds?.has(id)) throw new Error('这条会议记录已删除');
      const dir = this.meetingDir(id);
      const meetingsRoot = path.join(this.root, 'meetings');
      const rootStat = await fs.lstat(meetingsRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('会议存储目录无效');
      const dirStat = await fs.lstat(dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || path.dirname(path.resolve(dir)) !== path.resolve(meetingsRoot)) throw new Error('会议路径无效');
      this.pendingDeleteIds ||= new Set();
      this.pendingDeleteIds.add(id);
      await this.writeDeletionState();
      try { await this.removeMeetingDirectory(dir); }
      catch (error) {
        this.pendingDeleteIds.delete(id);
        try { await this.writeDeletionState(); } catch (rollbackError) { error.message += `；删除状态回写失败：${rollbackError.message}`; }
        throw new Error(`无法删除会议文件，可重试：${error.message}`);
      }
      this.pendingDeleteIds.delete(id); this.deletedIds.add(id);
      await this.writeDeletionState();
      // Remove the legacy copy too, so migrations cannot recreate this meeting.
      const legacyFile = path.join(this.root, 'huiyi-data.json');
      try {
        const legacy = JSON.parse(await fs.readFile(legacyFile, 'utf8'));
        if (Array.isArray(legacy.meetings)) await this.atomic(legacyFile, { ...legacy, meetings: legacy.meetings.filter(item => item.id !== id) });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return true;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async list({ query = '' } = {}) {
    await this.tail;
    const entries = await fs.readdir(path.join(this.root, 'meetings'), { withFileTypes: true });
    const tokens = String(query).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const meetings = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (this.deletedIds?.has(entry.name)) continue;
      let meeting;
      try { meeting = await this.get(entry.name); } catch { continue; }
      const transcript = meeting.transcript || meeting.segments?.map(item => item.text).join(' ') || '';
      const allText = [meeting.title, transcript, meeting.summary, meeting.notes, ...(meeting.highlights || []), ...(meeting.todos || []).map(item => `${item.title} ${item.owner}`), ...Object.values(meeting.speakerNames || {})].filter(Boolean).join('\n');
      const normalized = allText.toLocaleLowerCase();
      if (!tokens.every(token => normalized.includes(token))) continue;
      const index = tokens.length ? Math.max(0, normalized.indexOf(tokens[0]) - 30) : 0;
      meetings.push({ id: meeting.id, title: meeting.title, date: meeting.date, status: meeting.status, duration: meeting.duration || 0, diarized: !!meeting.diarized, snippet: allText.slice(index, index + 150) });
    }
    return meetings.sort((a, b) => new Date(b.date) - new Date(a.date));
  }
  async settings() {
    try { return JSON.parse(await fs.readFile(path.join(this.root, 'settings.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { config: {} }; throw error; }
  }
  async saveSettings(value) { await this.atomic(path.join(this.root, 'settings.json'), value); }
}
module.exports = { Store };
