const $ = (id) => document.getElementById(id);
const api = window.desktop;
try { Object.defineProperty(window, 'close', { configurable: false, writable: false, value: () => api.requestClose() }); }
catch { window.close = () => api.requestClose(); }
const ui = { meeting: null, audio: null, audioQueue: [], inferenceStrategy: 'full', busy: false, recording: false, stream: null, context: null, source: null, gain: null, worklet: null, flushed: null, timer: null, startedAt: 0, seconds: 0, liveRecognizedSeconds: 0, liveAsrReady: false, liveSpeakerReady: false, liveCommitted: [], liveSpeakerTurns: [], liveDraft: '', liveDraftSpeaker: '', waveformSpeaker: '', saveTimer: null, savePendingSnapshot: null, saveInFlight: null, queryTimer: null, eventOff: null, stopOff: null, partials: [], operationStage: '', operationVersion: 0, progressTimer: null, progressData: null, progressStartedAt: 0, inferenceTimer: null, inferenceData: null, inferenceStartedAt: 0, deletingId: null, autoNotesPendingId: null, autoNotesError: null };
ui.gpu = { available: false, name: '' };
function selectedDevice() { return ui.gpu.available && $('transcriptionDevice')?.value === 'cuda' ? 'cuda' : 'cpu'; }
function selectedSpeakerDevice() { return ui.gpu.available && $('speakerDevice')?.value === 'cuda' ? 'cuda' : 'cpu'; }
function selectedCudaVariant() { return selectedDevice() === 'cuda' || selectedSpeakerDevice() === 'cuda' ? ui.gpu.cudaVariant : ''; }
async function loadGpuCapability(detect = () => api.getNvidiaGpu()) {
  try { ui.gpu = await detect(); } catch { ui.gpu = { available: false, name: '' }; }
  $('gpuDeviceOption').classList.toggle('hidden', !ui.gpu.available);
  $('speakerDeviceOption').classList.toggle('hidden', !ui.gpu.available);
  $('gpuDeviceName').textContent = ui.gpu.available ? ui.gpu.name : '';
  $('transcriptionDevice').value = 'cpu';
}

function toast(message, error = false) { const el = $('toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.remove('hidden'); el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 3200); }
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatTime(seconds = 0) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`; }
function resetWaveform() {
  ui.waveformSpeaker = '';
  $('waveform').style.setProperty('--wave-color', '#e5a1a1');
  delete $('waveform').dataset.speaker;
  $('waveform').classList.remove('is-speaking');
  for (const bar of $('waveform').children) bar.style.height = '5px';
}
function setWaveformSpeaker(speaker) {
  if (!speaker) return;
  ui.waveformSpeaker = String(speaker);
  const colors = ['#e36b6e', '#6485d6', '#34a789', '#d59642', '#a277c4', '#328ba6'];
  const index = Number(ui.waveformSpeaker.match(/(\d+)$/)?.[1] || 1) - 1;
  $('waveform').style.setProperty('--wave-color', colors[((index % colors.length) + colors.length) % colors.length]);
  $('waveform').dataset.speaker = ui.waveformSpeaker;
}
function renderWaveformLevel(level, barLevels) {
  const waveform = $('waveform');
  if (!waveform || !Number.isFinite(level)) return;
  const floor = 0.008, ceiling = 0.12;
  const normalize = value => value <= floor ? 0 : Math.max(0, Math.min(1, (Math.log(value) - Math.log(floor)) / (Math.log(ceiling) - Math.log(floor))));
  waveform.classList.toggle('is-speaking', normalize(level) > 0.04);
  for (let i = 0; i < waveform.children.length; i++) {
    const amplitude = normalize(Number(barLevels?.[i]) || 0);
    waveform.children[i].style.height = `${5 + amplitude * 43}px`;
  }
}
function formatDuration(seconds = 0) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return n >= 3600 ? `${Math.floor(n/3600)} 小时 ${Math.floor(n%3600/60)} 分` : `${Math.floor(n/60)} 分钟`; }
function formatDate(value) { const d = value ? new Date(value) : new Date(); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function syncPlayback() {
  const meeting = ui.meeting;
  const hasSource = !!(meeting?.audioPath || ui.audio?.path);
  const area = $('playbackControls');
  const player = $('audioPlayer');
  (meeting ? $('meetingPlayback') : $('importFile')).appendChild(area);
  $('meetingPlayback').classList.toggle('hidden', !meeting || !meeting.audioPath);
  if (!meeting && ui.audio) $('importFile').classList.remove('hidden');
  const source = meeting?.audioUrl || (meeting?.audioPath ? `file://${encodeURI(meeting.audioPath)}` : ui.audio?.url || (ui.audio?.path ? `file://${encodeURI(ui.audio.path)}` : ''));
  if (player.dataset.source !== source) {
    player.dataset.source = source;
    if (source) player.src = source;
    else player.removeAttribute('src');
    player.load();
  }
  $('playAudioButton').disabled = !hasSource;
  area.classList.toggle('hidden', ui.audioQueue.length > 1);
  $('playbackSeek').disabled = !hasSource || !Number.isFinite(player.duration);
  if (!hasSource) {
    $('playbackCurrent').textContent = '00:00'; $('playbackDuration').textContent = '--:--';
    $('playbackSeek').max = '0'; $('playbackSeek').value = '0';
  }
  updatePlaybackState();
}
function updatePlaybackState() {
  const player = $('audioPlayer');
  const playing = !player.paused && !player.ended;
  $('playAudioButton').textContent = playing ? '❚❚ 暂停' : '▶ 播放';
  $('playAudioButton').setAttribute('aria-label', playing ? '暂停录音' : '播放录音');
  $('playAudioButton').setAttribute('aria-pressed', String(playing));
}
function reportPlaybackError(error) { if (error?.name !== 'AbortError') toast(`无法播放录音：${error.message}`,true); }
function updatePlaybackProgress() {
  const player = $('audioPlayer');
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  $('playbackCurrent').textContent = formatTime(player.currentTime);
  $('playbackDuration').textContent = duration ? formatTime(duration) : '--:--';
  $('playbackSeek').max = String(duration);
  $('playbackSeek').value = String(Math.min(player.currentTime || 0, duration));
  $('playbackSeek').disabled = !ui.meeting?.audioPath && !ui.audio?.path || !duration;
}
function setOperation(stage, message) { if(!['record','record-start','import','retry','finalize'].includes(stage))clearStartupProgress(); ui.operationStage=stage; $('operationText').textContent=message; $('operationError').textContent=''; $('operationError').classList.add('hidden'); $('dismissOperation').classList.add('hidden'); $('operationBar').classList.remove('is-error','is-idle','hidden'); }
const startupStages = {runtime:'准备运行环境',dependencies:'安装组件','model-download':'下载语音模型','live-model-download':'下载实时识别模型','punctuation-download':'下载标点模型','model-verify':'校验语音模型','model-load':'加载模型','speakers-download':'下载发言人模型',engine:'准备语音引擎'};
function clearStartupProgress() { clearInterval(ui.progressTimer); ui.progressTimer=null; ui.progressData=null; ui.progressStartedAt=0; $('startupProgress').classList.add('hidden'); $('startupProgressDetails').textContent=''; $('startupProgressFill').style.width='0%'; $('startupProgressTrack')?.classList.remove('indeterminate'); clearInterval(ui.inferenceTimer); ui.inferenceTimer=null; ui.inferenceData=null; ui.inferenceStartedAt=0; $('inferenceProgress').classList.add('hidden'); $('inferenceProgressDetails').textContent=''; $('inferenceProgressFill').style.width='0%'; $('inferenceProgressTrack')?.classList.remove('indeterminate'); }
function formatBytes(n) { if (!Number.isFinite(n)||n<0) return ''; const units=['B','KB','MB','GB']; let value=n,index=0; while(value>=1024&&index<units.length-1){value/=1024;index++;} return `${value.toFixed(index?1:0)} ${units[index]}`; }
function renderStartupProgress() {
  const p=ui.progressData; if(!p)return;
  const elapsed=Math.max(0,Math.floor((Date.now()-ui.progressStartedAt)/1000));
  const isDownload=['model-download','live-model-download','punctuation-download','speakers-download'].includes(p.stage);
  const speed=(Date.now()-p.lastAt>2500)?0:(Number(p.speed)||0);
  const total=Number(p.total)||0, downloaded=Math.max(0,Number(p.downloaded)||0), known=isDownload&&total>0;
  $('startupProgress').classList.remove('hidden');
  $('operationText').textContent=p.message||startupStages[p.stage]||'正在准备语音引擎';
  $('startupSteps').textContent=['runtime','dependencies','model-download','live-model-download','punctuation-download','model-verify','model-load'].map(x=>`${startupStages[x]}${p.stage===x?' ·':''}`).join('　›　');
  const track=$('startupProgress').querySelector('.startup-progress-track');
  track.classList.toggle('indeterminate',!known);
  $('startupProgressFill').style.width=known?`${Math.min(100,downloaded/total*100)}%`:'';
  if(known)track.setAttribute('aria-valuenow',String(Math.min(100,Math.round(downloaded/total*100))));else track.removeAttribute('aria-valuenow');
  if(!isDownload) {
    const status=p.stage==='model-verify'?(/完成|成功|已校验/.test(p.message||'')?'已校验':'正在校验'):p.stage==='model-load'?'正在加载':p.stage==='dependencies'?'正在安装组件':p.stage==='runtime'?'正在准备运行环境':'正在准备';
    const detail=p.detail?`${p.detail} · `:'';
    const hint=p.stage==='dependencies'&&elapsed>=60?(selectedDevice()==='cuda'?'首次安装 NVIDIA CUDA 语音依赖可能需要较长时间，请保持网络连接。':'首次安装语音依赖可能需要较长时间，请保持网络连接。'):'';
    $('startupProgressDetails').textContent=`${detail}${hint?`${hint} · `:''}${status} · 已耗时 ${formatTime(elapsed)}`;
    return;
  }
  const reportedEta=Number.isFinite(p.eta)&&p.eta>=0?p.eta:null;
  const eta=known&&speed>0?(reportedEta===null?Math.ceil(Math.max(0,total-downloaded)/speed):Math.ceil(reportedEta)):null;
  const status=speed===0?'速度暂时为 0，请等待或检查网络连接。':`${formatBytes(speed)}/秒`;
  $('startupProgressDetails').textContent=known?`${Math.round(downloaded/total*100)}% · 已下载 ${formatBytes(downloaded)} / ${formatBytes(total)} · ${status}${eta===null?'':` · 预计剩余 ${formatTime(eta)}`} · 已耗时 ${formatTime(elapsed)}`:`已下载 ${formatBytes(downloaded)||'—'} · ${status} · 已耗时 ${formatTime(elapsed)}`;
}
function showStartupProgress(payload) {
  if((!['record','record-start','import','retry','finalize'].includes(ui.operationStage)&&!ui.recording)||!startupStages[payload.stage])return;
  if(!ui.progressStartedAt)ui.progressStartedAt=Date.now();
  const id=payload.transferId||`${payload.stage}:${payload.filename||''}`;
  const old=ui.progressData;
  if(!old||old.key!==id||old.stage!==payload.stage) ui.progressData={key:id,stage:payload.stage,lastAt:Date.now(),lastDownloaded:Number(payload.downloaded)||0,speed:Number.isFinite(payload.speed)?Math.max(0,payload.speed):0,eta:Number.isFinite(payload.eta)?payload.eta:null,total:Number(payload.total)||0,downloaded:Number(payload.downloaded)||0,message:payload.message,detail:payload.detail};
  else {
    const now=Date.now(), bytes=Number(payload.downloaded)||0, dt=(now-old.lastAt)/1000;
    if(Number.isFinite(payload.speed))old.speed=Math.max(0,payload.speed);
    else if(bytes>old.lastDownloaded&&dt>0)old.speed=(bytes-old.lastDownloaded)/dt;
    old.eta=Number.isFinite(payload.eta)?payload.eta:null;old.lastAt=now;old.lastDownloaded=bytes;old.downloaded=bytes;old.total=Number(payload.total)||0;old.message=payload.message||old.message;old.detail=payload.detail||old.detail;
  }
  if(!ui.progressTimer)ui.progressTimer=setInterval(renderStartupProgress,1000);
  renderStartupProgress();
}
function formatAudioTime(seconds) { return formatTime(seconds); }
function inferenceStageName(stage) { if(stage==='speakers')return '正在区分发言人'; if(stage==='transcribe')return '正在转写导入录音'; if(stage==='finish-transcript')return '整理实时转写'; return ui.inferenceStrategy==='fast'?'正在补齐末尾转写':'正在校正完整录音'; }
const speakerRateStorageKey='speaker-diarization-seconds-per-audio-second';
function speakerSecondsPerAudioSecond() {
  try { const value=Number(localStorage.getItem(speakerRateStorageKey)); if(Number.isFinite(value)&&value>=0.02&&value<=4)return value; } catch {}
  return 0.2;
}
function renderInferenceProgress() {
  const p=ui.inferenceData; if(!p)return;
  const track=$('inferenceProgressTrack');
  const processed=Number.isFinite(p.processed)?Math.max(0,p.processed):null;
  const total=Number.isFinite(p.totalSeconds)&&p.totalSeconds>0?p.totalSeconds:null;
  const known=processed!==null&&total!==null;
  const elapsed=Math.max(0,Math.floor(Math.max(p.elapsed+Math.max(0,(Date.now()-p.receivedAt)/1000),(Date.now()-ui.inferenceStartedAt)/1000)));
  const speakerEstimate=p.stage==='speakers'&&Number.isFinite(p.totalSeconds)&&p.totalSeconds>0;
  const estimatedStageSeconds=speakerEstimate?Math.max(20,Math.round(p.totalSeconds*speakerSecondsPerAudioSecond())):null;
  const speakerOverEstimate=speakerEstimate&&!p.complete&&elapsed>=estimatedStageSeconds;
  const percent=known?Math.min(100,Math.max(0,processed/total*100)):speakerEstimate?(p.complete?100:Math.min(95,elapsed/estimatedStageSeconds*100)):null;
  const eta=Number.isFinite(p.eta)&&p.eta>=0?Math.max(0,Math.ceil(p.eta-Math.max(0,(Date.now()-p.receivedAt)/1000))):speakerEstimate&&!p.complete&&!speakerOverEstimate?Math.max(0,estimatedStageSeconds-elapsed):null;
  const speed=Number.isFinite(p.audioSpeed)&&p.audioSpeed>0?`处理速度 ${p.audioSpeed.toFixed(1)} 倍速`:'';
  const fullFallback=p.stage==='refine'&&/校正完整录音/.test(p.message||'');
  const stageLabel=p.stage==='speakers'?'声纹区分':p.stage==='transcribe'?'语音转写':p.stage==='finish-transcript'?'实时文字整理':ui.inferenceStrategy==='fast'&&!fullFallback?'补齐缺失转写':'全文校正';
  $('inferenceProgressLabel').textContent=`${stageLabel} · ${p.message || inferenceStageName(p.stage)}`;
  $('inferenceProgress').classList.remove('hidden');
  track.setAttribute('aria-label',speakerEstimate?'声纹区分预估进度':'本机转写进度');
  track.classList.toggle('indeterminate',!known&&!speakerEstimate);
  $('inferenceProgressFill').style.width=known?`${percent}%`:'';
  if(known)track.setAttribute('aria-valuenow',String(Math.round(percent)));else track.removeAttribute('aria-valuenow');
  const details=[];
  if(known)details.push(`${Math.round(percent)}% · 已处理音频 ${formatAudioTime(processed)} / ${formatAudioTime(total)}`);
  else if(speakerEstimate)details.push(`${p.complete?'100% · 声纹分析完成':speakerOverEstimate?'预估进度 95% · 已超过预估时间':`预估进度 ${Math.round(percent)}%`} · 音频时长 ${formatAudioTime(p.totalSeconds)}`);
  else if(p.stage==='speakers')details.push('声纹区分进行中');
  else details.push('正在处理音频');
  if(speed)details.push(speed);
  details.push(`已耗时 ${formatTime(elapsed)}`);
  if(p.stage==='speakers')details.push(speakerOverEstimate?'处理时间超过预估，仍在区分发言人':eta===null?'预计时间正在估算':`预计剩余约 ${formatTime(eta)}`);
  else details.push(eta===null?'预计剩余时间正在估算':eta===0&&!p.complete?'即将更新 · 正在处理当前片段':`预计剩余 ${formatTime(eta)}`);
  $('inferenceProgressDetails').textContent=details.join(' · ');
  $('operationText').textContent=p.stage==='transcribe'||p.stage==='speakers'||p.stage==='finish-transcript'||(ui.inferenceStrategy==='fast'&&!fullFallback)?inferenceStageName(p.stage):(p.message||inferenceStageName(p.stage));
}
function showInferenceProgress(payload) {
  if(!['record','record-start','import','retry','finalize'].includes(ui.operationStage)||!['transcribe','refine','finish-transcript','speakers'].includes(payload.stage))return;
  const now=Date.now();
  const old=ui.inferenceData;
  const stageChanged=!old||old.stage!==payload.stage;
  const elapsed=Number.isFinite(payload.elapsed)&&payload.elapsed>=0?payload.elapsed:(stageChanged?0:old.elapsed+Math.max(0,(now-old.receivedAt)/1000));
  const processed=Number.isFinite(payload.processedSeconds)?payload.processedSeconds:payload.processed;
  const totalSeconds=Number.isFinite(payload.totalSeconds)?payload.totalSeconds:null;
  if(payload.stage==='speakers'&&payload.complete===true&&payload.diarizationSucceeded===true&&totalSeconds>0&&elapsed>0) {
    try { const previous=speakerSecondsPerAudioSecond(); const actual=Math.min(4,Math.max(0.02,elapsed/totalSeconds)); localStorage.setItem(speakerRateStorageKey,String(Math.min(4,Math.max(0.02,previous*0.7+actual*0.3)))); } catch {}
  }
  ui.inferenceData={stage:payload.stage,processed:Number.isFinite(processed)?processed:null,totalSeconds,elapsed,eta:Number.isFinite(payload.eta)&&payload.eta>=0?payload.eta:null,audioSpeed:Number.isFinite(payload.audioSpeed)?payload.audioSpeed:null,message:payload.message,complete:payload.complete===true,receivedAt:now};
  if(!ui.inferenceStartedAt)ui.inferenceStartedAt=now;
  if(!ui.inferenceTimer)ui.inferenceTimer=setInterval(renderInferenceProgress,1000);
  renderInferenceProgress();
}
function showMergeProgress(payload) {
  if(ui.operationStage!=='import')return;
  const processed=Number.isFinite(payload.processedFiles)?Math.max(0,payload.processedFiles):null;
  const total=Number.isFinite(payload.totalFiles)&&payload.totalFiles>0?payload.totalFiles:null;
  const bytesKnown=payload.phase==='joining'&&Number.isFinite(payload.processedBytes)&&Number.isFinite(payload.totalBytes)&&payload.totalBytes>0;
  const countKnown=processed!==null&&total!==null; const known=bytesKnown||countKnown; const percent=bytesKnown?Math.min(100,payload.processedBytes/payload.totalBytes*100):countKnown?Math.min(100,processed/total*100):null;
  const phaseLabel=payload.phase==='converting'?'转换音频':payload.phase==='joining'?'拼接音频':payload.phase==='complete'?'音频合并完成':'按列表顺序合并音频';
  $('inferenceProgress').classList.remove('hidden'); $('inferenceProgressLabel').textContent=payload.message||phaseLabel;
  const track=$('inferenceProgressTrack'); track.classList.toggle('indeterminate',!known); $('inferenceProgressFill').style.width=known?`${percent}%`:'';
  if(known)track.setAttribute('aria-valuenow',String(Math.round(percent)));else track.removeAttribute('aria-valuenow');
  const seconds=Number.isFinite(payload.processedSeconds)&&Number.isFinite(payload.totalSeconds)&&payload.totalSeconds>0?` · ${formatAudioTime(payload.processedSeconds)} / ${formatAudioTime(payload.totalSeconds)}`:'';
  const bytes=bytesKnown?` · 已拼接 ${formatBytes(payload.processedBytes)} / ${formatBytes(payload.totalBytes)}`:'';
  $('inferenceProgressDetails').textContent=bytesKnown?`${Math.round(percent)}%${bytes}${seconds}`:countKnown?`${processed} / ${total} 个文件${seconds}`:`正在准备合并${seconds}`;
  $('operationText').textContent=payload.message||'正在合并导入音频';
}
function setOperationError(message) { clearStartupProgress(); $('operationText').textContent='处理遇到问题'; $('operationError').textContent=message || '未知错误'; $('operationError').classList.remove('hidden'); $('operationBar').classList.remove('hidden','is-idle'); $('operationBar').classList.add('is-error'); $('operationSpinner').classList.add('hidden'); $('cancelOperationButton').classList.add('hidden'); $('dismissOperation').classList.remove('hidden'); }
function setOperationDone(message) { clearStartupProgress(); $('operationText').textContent=message; $('operationError').textContent=''; $('operationError').classList.add('hidden'); $('operationBar').classList.remove('hidden','is-error'); $('operationBar').classList.add('is-idle'); $('operationSpinner').classList.add('hidden'); $('cancelOperationButton').classList.add('hidden'); $('dismissOperation').classList.remove('hidden'); }
function setBusy(value, label = '') {
  ui.busy = value; document.body.classList.toggle('busy', value);
  if(!value) clearStartupProgress();
  $('generateButton').disabled = value || ui.autoNotesPendingId === ui.meeting?.id; $('transcribeButton').disabled = value || !ui.audioQueue.length; $('recordButton').disabled = value; $('retryButton').disabled = value;
  $('saveButton').disabled=value; $('notesEditor').disabled=value;
  $('speakerEditor').querySelectorAll('input').forEach(input=>input.disabled=value);
  $('todosContent').querySelectorAll('input').forEach(input=>input.disabled=value);
  $('newMeeting').disabled = value || ui.recording; $('chooseAudio').disabled = value || ui.recording; $('removeAudio').disabled=value || ui.recording;
  document.querySelectorAll('.history-delete').forEach(button=>button.disabled=value||ui.recording||!!ui.deletingId);
  $('cancelOperationButton').classList.toggle('hidden', !value || ui.recording || ['ai','pick','cancel','switch','mic-permission'].includes(ui.operationStage));
  $('cancelOperationButton').disabled=ui.operationStage==='cancel';
  if (label) { $('liveStatus').textContent=label; if(value) $('operationText').textContent=label; }
  $('operationSpinner').classList.toggle('hidden', !value);
  if(value) $('operationBar').classList.remove('hidden','is-error','is-idle');
  else if(!$('operationBar').classList.contains('is-error')) { $('operationBar').classList.add('hidden'); }
  syncPosterButton();
}
function updateView() {
  const m = ui.meeting;
  $('setupCard').classList.toggle('hidden', !!m || ui.recording);
  $('recordingCard').classList.toggle('hidden', !ui.recording && !(m && ['recording','refining'].includes(m.status)));
  $('recordingCard').classList.toggle('is-recording', ui.recording && (!m || m.status === 'recording'));
  $('recordingSummaryPanel').classList.toggle('hidden', !ui.recording || !!m && m.status !== 'recording');
  $('liveTranscriptPanel').classList.toggle('hidden', !ui.recording || !!m && m.status !== 'recording');
  $('transcriptPanel').classList.toggle('hidden', !!m && m.status === 'recording');
  $('meetingView').classList.toggle('hidden', !m || m.status === 'recording');
  $('emptyState').classList.toggle('hidden', !!m || ui.recording);
  $('pageTitle').textContent = m?.title || '把讨论，变成下一步';
  $('breadcrumbTitle').textContent = m?.title || '新建会议';
  $('exportButton').disabled = !m;
  syncPlayback();
  if (!m) { renderTranscript(); renderSpeakers(); $('notesEditor').value=''; $('liveTranscript').innerHTML='<p class="placeholder">开始说话后，识别内容会显示在这里</p>'; syncPosterButton(); return; }
  $('meetingStatus').textContent = statusLabel(m.status);
  $('meetingStatus').className = `status-pill status-${m.status || 'completed'}`;
  $('meetingDate').textContent = formatDate(m.date);
  $('meetingDuration').textContent = m.duration ? formatDuration(m.duration) : '';
  $('retryButton').classList.toggle('hidden', !(m.audioUrl && (['failed','interrupted'].includes(m.status) || !!m.warning || !m.diarized)));
  const transcriptReady = !!(m.transcript || m.segments?.length);
  const canShowAi = m.status === 'completed' || m.status === 'refining' && transcriptReady;
  const autoGenerating = ui.autoNotesPendingId === m.id;
  const autoFailed = ui.autoNotesError?.id === m.id;
  $('aiBanner').classList.toggle('hidden', !canShowAi);
  $('aiBanner').querySelector('strong').textContent = m.summary ? '会议纪要已生成' : autoGenerating ? '逐字稿已就绪，正在生成纪要…' : autoFailed ? '自动生成失败，可稍后重试' : m.status === 'refining' ? '正在整理会议纪要…' : '转写完成，开始整理会议结果';
  $('aiBanner').querySelector('p').textContent = autoGenerating ? '纪要正在根据已识别的逐字稿生成。' : m.status === 'refining' ? '正在整理逐字稿和录音期间匹配的发言人。' : 'AI 根据逐字稿生成摘要、重点和待办；可在下方编辑纪要。';
  $('generateButton').innerHTML = m.summary ? '重新生成纪要 <span>→</span>' : autoGenerating ? '生成中…' : '生成会议纪要 <span>→</span>';
  $('generateButton').disabled = ui.busy || autoGenerating;
  $('summaryCaption').textContent = m.summary ? 'AI 生成' : '等待生成';
  renderSummary(); renderTranscript(); renderSpeakers(); renderTodos();
  if (document.activeElement !== $('notesEditor')) $('notesEditor').value = m.notes || '';
  syncPosterButton();
}
function statusLabel(status) { return ({preparing:'正在准备',recording:'正在录音',refining:'处理中',completed:'已完成',failed:'处理失败',interrupted:'录音中断'})[status] || '状态未知'; }
function renderSummary() { const m=ui.meeting; $('summaryContent').innerHTML = m?.summary ? `<p>${escapeHtml(m.summary)}</p>` : '<p class="muted">生成后，会议结论会显示在这里。</p>'; $('highlightsContent').innerHTML = m?.highlights?.length ? `<ul>${m.highlights.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<p class="muted">提炼出的重点会显示在这里。</p>'; }
function renderTranscript() {
  const transcript = ui.meeting?.transcript;
  const segments = ui.meeting?.segments || [];
  if (!segments.length && transcript) {
    $('transcriptCount').textContent = '原始文本';
    $('transcriptList').innerHTML = `<p>${escapeHtml(transcript)}</p>`;
    return;
  }
  $('transcriptCount').textContent = `${segments.length} 段`;
  if (!segments.length) { $('transcriptList').innerHTML = '<p class="muted">录音转写后，逐字稿会显示在这里。</p>'; return; }
  $('transcriptList').innerHTML = segments.map((s,i) => {
    const key=s.speaker; const name=key ? (ui.meeting.speakerNames?.[key] || key.replace('speaker_', '发言人 ')) : '未区分';
    return `<article class="transcript-segment" data-segment="${escapeHtml(s.id ?? i)}"><button class="segment-time" data-seek="${Number(s.start)||0}">${formatTime(s.start)}</button><div class="segment-main"><div class="segment-speaker">${escapeHtml(name)}</div><p>${escapeHtml(s.text)}</p></div></article>`;
  }).join('');
  $('transcriptList').querySelectorAll('[data-seek]').forEach(button => button.addEventListener('click', () => { const player=$('audioPlayer'); if (ui.meeting?.audioPath) { player.currentTime=Number(button.dataset.seek); player.play().then(updatePlaybackState).catch(reportPlaybackError); } }));
}
function renderSpeakers() {
  const keys = [...new Set((ui.meeting?.segments || []).map(s=>s.speaker).filter(Boolean))];
  const editor=$('speakerEditor');
  editor.classList.toggle('hidden', !keys.length || editor.dataset.open !== 'true');
  editor.innerHTML = keys.map(key=>`<label><span>${escapeHtml(key.replace('speaker_','发言人 '))}</span><input data-speaker="${escapeHtml(key)}" value="${escapeHtml(ui.meeting.speakerNames?.[key] || key.replace('speaker_','发言人 '))}" maxlength="40" /></label>`).join('');
  editor.querySelectorAll('input').forEach(input=>{input.disabled=ui.busy;input.addEventListener('input',()=>{ ui.meeting.speakerNames ||= {}; ui.meeting.speakerNames[input.dataset.speaker]=input.value; renderTranscript(); scheduleSave(); });});
}
function renderTodos() {
  const todos=ui.meeting?.todos || []; $('todoCount').textContent=`${todos.length} 项`;
  $('todosContent').innerHTML = todos.length ? todos.map((t,i)=>`<label class="todo-item"><input type="checkbox" data-todo="${i}" ${t.done?'checked':''}><span class="todo-check"></span><span class="todo-title ${t.done?'done':''}">${escapeHtml(t.title)}</span><small>${escapeHtml([t.owner,t.due].filter(Boolean).join(' · ') || '待确认')}</small></label>`).join('') : '<p class="muted">会议行动项会显示在这里。</p>';
  $('todosContent').querySelectorAll('[data-todo]').forEach(input=>{input.disabled=ui.busy;input.addEventListener('change',()=>{ ui.meeting.todos[Number(input.dataset.todo)].done=input.checked; renderTodos(); scheduleSave(); });});
}
function snapshotForSave(id) { if (!ui.meeting || ui.meeting.id !== id) return null; return { id, title: ui.meeting.title, notes: $('notesEditor').value, summary: ui.meeting.summary, highlights: ui.meeting.highlights, todos: ui.meeting.todos, speakerNames: ui.meeting.speakerNames }; }
async function saveSnapshot(snapshot, quiet=true) {
  if (!snapshot) return;
  const previous=ui.saveInFlight;
  const task=(async()=>{ if(previous) await previous.catch(()=>{}); await api.saveMeeting(snapshot); await loadHistory(); })();
  ui.saveInFlight=task;
  try { await task; if (!quiet) toast('已保存'); return true; }
  catch(e) { if (ui.meeting?.id===snapshot.id && !ui.savePendingSnapshot) ui.savePendingSnapshot=snapshotForSave(snapshot.id); if (!quiet) toast(`保存失败：${e.message}`,true); else setOperationError(`自动保存失败：${e.message}`); return false; }
  finally { if(ui.saveInFlight===task) ui.saveInFlight=null; }
}
function flushPendingSave() { clearTimeout(ui.saveTimer); ui.saveTimer=null; const pending=ui.savePendingSnapshot; const current=snapshotForSave(ui.meeting?.id); const snapshot=current && (!pending || pending.id===current.id) ? current : pending; ui.savePendingSnapshot=null; return (async()=>{ if(snapshot && await saveSnapshot(snapshot) === false) { ui.savePendingSnapshot=snapshot; throw new Error('当前会议未保存，请检查磁盘空间或先导出纪要。'); } if(ui.saveInFlight) await ui.saveInFlight; })(); }
function scheduleSave() {
  const snapshot=snapshotForSave(ui.meeting?.id);
  if(!snapshot) return;
  if(ui.savePendingSnapshot && ui.savePendingSnapshot.id!==snapshot.id) flushPendingSave();
  clearTimeout(ui.saveTimer); ui.savePendingSnapshot=snapshot;
  ui.saveTimer=setTimeout(()=>{const pending=ui.savePendingSnapshot;ui.savePendingSnapshot=null;ui.saveTimer=null;void saveSnapshot(pending);},550);
}
async function loadHistory(query = $('historySearch').value) {
  const version = (ui.historyVersion || 0) + 1; ui.historyVersion = version;
  try { const rows=await api.listHistory({query}); if (version !== ui.historyVersion) return; const list=$('historyList'); $('historyCount').textContent=String(rows.length); list.replaceChildren();
    for (const row of rows) {
      const item=document.createElement('div'); item.className='history-entry-row';
      const b=document.createElement('button'); b.className='history-entry'+(ui.meeting?.id===row.id?' selected':''); b.innerHTML=`<span class="history-entry-title">${escapeHtml(row.title||'未命名会议')}</span><span class="history-entry-meta">${escapeHtml(formatDate(row.date))} · ${escapeHtml(statusLabel(row.status))}</span>`; b.title=row.snippet||row.title||''; b.addEventListener('click',()=>openMeeting(row.id));
      const edit=document.createElement('button'); edit.className='history-rename'; edit.type='button'; edit.textContent='改名'; edit.setAttribute('aria-label',`修改会议标题：${row.title||'未命名会议'}`); edit.disabled=ui.busy||ui.recording; edit.addEventListener('click',()=>beginHistoryRename(item,b,edit,row.title||'未命名会议'));
      const input=document.createElement('input'); input.className='history-rename-input hidden'; input.type='text'; input.maxLength=120; input.value=row.title||''; input.setAttribute('aria-label','会议标题');
      const save=document.createElement('button'); save.className='history-rename-action hidden'; save.type='button'; save.textContent='保存';
      const cancel=document.createElement('button'); cancel.className='history-rename-action hidden'; cancel.type='button'; cancel.textContent='取消';
      save.addEventListener('click',()=>commitHistoryRename(row.id,input.value,save,cancel));
      cancel.addEventListener('click',()=>finishHistoryRename(item,b,edit,input,save,cancel));
      input.addEventListener('keydown',event=>{if(event.key==='Enter')save.click();if(event.key==='Escape')cancel.click();});
      const del=document.createElement('button'); del.className='history-delete'; del.type='button'; del.textContent='删除'; del.setAttribute('aria-label',`删除会议：${row.title||'未命名会议'}`); del.disabled=ui.busy||ui.recording; del.addEventListener('click',()=>deleteMeetingFromHistory(row.id));
      item.append(b,input,save,cancel,edit,del); list.appendChild(item);
    }
    if (!rows.length) list.innerHTML=`<div class="history-empty">${query?'没有找到相关会议':'还没有会议记录'}</div>`;
  } catch (e) { console.error(e); }
}
function beginHistoryRename(item,button,edit,title) {
  item.querySelector('.history-rename-input').value=title;
  button.classList.add('hidden'); edit.classList.add('hidden');
  item.querySelector('.history-rename-input').classList.remove('hidden');
  item.querySelectorAll('.history-rename-action').forEach(action=>action.classList.remove('hidden'));
  item.querySelector('.history-rename-input').focus(); item.querySelector('.history-rename-input').select();
}
function finishHistoryRename(item,button,edit,input,save,cancel) {
  button.classList.remove('hidden'); edit.classList.remove('hidden'); input.classList.add('hidden'); save.classList.add('hidden'); cancel.classList.add('hidden');
}
async function commitHistoryRename(id,value,save,cancel) {
  if(ui.busy||ui.recording)return;
  const title=String(value||'').trim();
  if(!title||title.length>120)return toast('会议标题不能为空，且不能超过 120 个字符。',true);
  save.disabled=true; cancel.disabled=true;
  try {
    await flushPendingSave();
    const meeting=await api.saveMeeting({id,title});
    if(ui.meeting?.id===id){ui.meeting.title=meeting.title;updateView();}
    await loadHistory(); toast('会议标题已修改');
  } catch(error) { toast(`修改标题失败：${error.message}`,true); save.disabled=false; cancel.disabled=false; }
}
async function deleteMeetingFromHistory(id) {
  if(ui.busy||ui.recording||ui.deletingId)return;
  const deletingCurrent=ui.meeting?.id===id;
  clearTimeout(ui.saveTimer); ui.saveTimer=null; ui.deletingId=id;
  try {
    const result=await api.deleteMeeting(id);
    if(!result?.deleted) { if(deletingCurrent&&ui.savePendingSnapshot?.id===id)scheduleSave(); return; }
    if(ui.saveInFlight)await ui.saveInFlight.catch(()=>{});
    if(deletingCurrent) {
      ui.savePendingSnapshot=null; ui.meeting=null; ui.audio=null; ui.audioQueue=[]; ui.partials=[]; $('notesEditor').value=''; $('meetingTitle').value=''; $('importFile').classList.add('hidden'); renderAudioQueue();
      closePoster(); updateView();
    }
    await loadHistory(); toast('会议记录已删除');
  } catch(error) {
    if(deletingCurrent&&ui.savePendingSnapshot?.id===id)scheduleSave();
    toast(`删除失败：${error.message}`,true);
  } finally { ui.deletingId=null; }
}
async function openMeeting(id) {
  if (ui.busy || ui.recording) return toast('当前操作完成后再切换会议');
  setOperation('switch','正在保存并打开会议…'); setBusy(true,'正在保存并打开会议…');
  try { await flushPendingSave(); const meeting=await api.getMeeting(id); if (!meeting) return; ui.meeting=meeting; ui.audio=null; ui.audioQueue=[]; $('importFile').classList.add('hidden'); renderAudioQueue(); updateView(); await loadHistory(); window.scrollTo({top:0,behavior:'smooth'}); }
  catch(e) { setOperationError(`打开失败：${e.message}`); toast(`打开失败：${e.message}`,true); }
  finally { setBusy(false); ui.operationStage=''; }
}
async function resetMeeting() {
  if (ui.busy || ui.recording) return toast('当前操作完成后再新建会议');
  setOperation('switch','正在保存当前会议…'); setBusy(true,'正在保存当前会议…');
  try { await flushPendingSave(); ui.meeting=null; ui.audio=null; ui.audioQueue=[]; ui.partials=[]; ui.liveCommitted=[]; ui.liveDraft=''; ui.liveRecognizedSeconds=0; $('speakerEditor').dataset.open='false'; $('importFile').classList.add('hidden'); $('meetingTitle').value=''; $('liveStatus').textContent='正在连接麦克风…'; renderAudioQueue(); updateView(); }
  catch(e) { setOperationError(`保存当前会议失败：${e.message}`); }
  finally { setBusy(false); ui.operationStage=''; }
}
async function cleanupCapture() {
  clearInterval(ui.timer); ui.timer=null;
  try { ui.source?.disconnect(); ui.worklet?.disconnect(); ui.gain?.disconnect(); } catch {}
  ui.stream?.getTracks().forEach(t=>t.stop());
  if(ui.context && ui.context.state!=='closed') { try { await ui.context.close(); } catch {} }
  ui.stream=ui.context=ui.source=ui.gain=ui.worklet=null; ui.recording=false;
  resetWaveform();
}

async function selectAudio(file) {
  if (!file || ui.busy || ui.recording) return;
  const files=(Array.isArray(file)?file:[file]).filter(Boolean);
  for (const item of files) if (!item.path && api.getPathForFile) item.path=api.getPathForFile(item);
  if (!files.length || files.some(item=>!item.path)) return toast('无法读取音频文件路径',true);
  ui.audioQueue=files; ui.audio=files.length===1?files[0]:null;
  const first=files[0];
  $('fileName').textContent=files.length===1?first.name:`${first.name} 等 ${files.length} 段录音`;
  const totalBytes=files.reduce((sum,item)=>sum+(Number(item.size)||0),0);
  $('fileMeta').textContent=`${files.length} 个文件按列表顺序拼接${totalBytes?` · ${(totalBytes/1024/1024).toFixed(1)} MB`:''} · 准备转写`;
  $('transcribeButton').disabled=ui.busy;
  renderAudioQueue(); $('importFile').classList.remove('hidden'); $('emptyState').classList.add('hidden'); $('meetingTitle').value=$('meetingTitle').value || (files.length===1?first.name.replace(/\.[^.]+$/,''):`${first.name.replace(/\.[^.]+$/,'')} 等${files.length}段录音`); syncPlayback();
}
function renderAudioQueue() {
  const list=$('audioQueueList'); const multi=ui.audioQueue.length>1;
  list.classList.toggle('hidden',!multi); list.innerHTML=multi?ui.audioQueue.map((file,index)=>`<li><span class="audio-queue-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><span class="audio-queue-actions"><button type="button" data-audio-up="${index}" aria-label="上移 ${escapeHtml(file.name)}" ${index===0?'disabled':''}>↑</button><button type="button" data-audio-down="${index}" aria-label="下移 ${escapeHtml(file.name)}" ${index===ui.audioQueue.length-1?'disabled':''}>↓</button><button type="button" data-audio-remove="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button></span></li>`).join(''):'';
}
async function pickAudio() { if (ui.busy || ui.recording) return; setOperation('pick','正在选择音频…'); setBusy(true); try { const f=await api.openAudio(); setBusy(false); if (f) { await resetMeeting(); await selectAudio(f); } } catch(e) { setBusy(false); setOperationError(`打开音频失败：${e.message}`); toast(`打开音频失败：${e.message}`,true); } }

async function startRecording() {
  if (ui.busy || ui.recording) return;
  const operationVersion=++ui.operationVersion;
  ui.partials=[]; ui.liveCommitted=[]; ui.liveDraft=''; ui.liveRecognizedSeconds=0; ui.liveAsrReady=false; ui.liveSpeakerReady=false;
  let startedMeeting = null;
  setOperation('mic-permission','正在申请麦克风权限…');
  setBusy(true,'正在申请麦克风权限…');
  try {
    await api.requestMicrophonePermission();
    if(operationVersion!==ui.operationVersion) return;
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    ui.stream=stream;
    if(operationVersion!==ui.operationVersion) { stream.getTracks().forEach(t=>t.stop()); ui.stream=null; return; }
    const title=$('meetingTitle').value.trim() || `会议 ${new Date().toLocaleDateString('zh-CN')}`;
    setOperation('record-start','正在启动本机语音引擎…');
    const meeting=await api.startRecording({title,language:$('language').value,model:$('model').value,speakers:Number($('speakers').value),finalizeStrategy:$('finalizeStrategy').value,device:selectedDevice(),speakerDevice:selectedSpeakerDevice(),cudaVariant:selectedCudaVariant()});
    startedMeeting=meeting;
    if(operationVersion!==ui.operationVersion) { stream.getTracks().forEach(t=>t.stop()); try { await api.stopRecording({id:meeting.id}); } catch {} ui.stream=null; return; }
    ui.meeting=meeting; ui.inferenceStrategy=meeting.finalizeStrategy||$('finalizeStrategy').value; ui.startedAt=Date.now(); ui.seconds=0;
    resetWaveform();
    const context=new AudioContext({sampleRate:16000}); ui.context=context; await context.audioWorklet.addModule(new URL('audio-worklet.js',location.href));
    if(operationVersion!==ui.operationVersion) { await cleanupCapture(); return; }
    const source=context.createMediaStreamSource(stream); const worklet=new AudioWorkletNode(context,'meeting-recorder'); const gain=context.createGain(); gain.gain.value=0;
    ui.source=source;ui.worklet=worklet;ui.gain=gain; source.connect(worklet);worklet.connect(gain);gain.connect(context.destination);
    worklet.port.onmessage=event=>{
      if (event.data?.type==='audio' && ui.meeting?.id===meeting.id) { renderWaveformLevel(event.data.level,event.data.barLevels); api.sendAudio({id:meeting.id,pcm:event.data.pcm}); }
      if (event.data?.type==='flushed' && ui.flushed) { ui.flushed(); ui.flushed=null; }
    };
    await context.resume();
    if(operationVersion!==ui.operationVersion) { await cleanupCapture(); return; }
    ui.recording=true; $('recordingCard').classList.remove('hidden'); $('setupCard').classList.add('hidden'); $('meetingView').classList.add('hidden'); $('emptyState').classList.add('hidden');
    $('recordingState').textContent='正在录音'; $('liveStatus').textContent=ui.liveAsrReady?'麦克风已连接 · 正在实时识别':'录音中 · Whisper 将逐段显示识别结果'; $('liveSpeakerStatus').textContent=ui.liveSpeakerReady?'边录边匹配发言人':'实时声纹模型准备中'; $('liveTranscript').innerHTML='<p class="placeholder">文字会随语音实时更新，句末补标点，识别到后显示发言人</p>'; $('recordingClock').textContent='00:00'; ui.liveRecognizedSeconds=0; ui.liveCommitted=[]; ui.liveSpeakerTurns=[]; ui.liveDraft=''; ui.liveDraftSpeaker='';
    ui.timer=setInterval(()=>{ ui.seconds=Math.floor((Date.now()-ui.startedAt)/1000); $('recordingClock').textContent=formatTime(ui.seconds); },250);
    updateView(); setBusy(false); ui.operationStage=''; $('newMeeting').disabled=true; $('chooseAudio').disabled=true; $('recordButton').disabled=true;
  } catch(e) {
    await cleanupCapture();
    if (startedMeeting?.id) {
      try { ui.meeting=await api.stopRecording({id:startedMeeting.id}); await loadHistory(); }
      catch { try { ui.meeting=await api.getMeeting(startedMeeting.id); } catch {} }
      updateView();
    }
    if(operationVersion===ui.operationVersion) { setBusy(false); ui.operationStage=''; setOperationError(`无法开始录音：${e.message}`); toast(`无法开始录音：${e.message}`,true); }
  }
}
async function stopRecording() {
  if (!ui.recording || ui.busy) return;
  const operationVersion=++ui.operationVersion;
  let completed=false;
  ui.inferenceStrategy=ui.meeting?.finalizeStrategy||$('finalizeStrategy').value||'fast';
  const endMessage=ui.inferenceStrategy==='fast'?'正在补齐末尾转写并整理纪要…':'正在校正逐字稿并整理纪要…';
  setOperation('finalize',endMessage); setBusy(true,endMessage); $('stopButton').disabled=true; $('recordingState').textContent='正在处理会后转写'; $('progressWrap').classList.remove('hidden'); $('progressText').textContent=endMessage;
  const id=ui.meeting?.id;
  try {
    if (ui.worklet) { await new Promise(resolve=>{ ui.flushed=resolve; ui.worklet.port.postMessage('flush'); setTimeout(()=>{if(ui.flushed){ui.flushed();ui.flushed=null;}},2000); }); }
    await cleanupCapture();
    const finished=await api.stopRecording({id}); if(operationVersion!==ui.operationVersion)return; ui.meeting={...ui.meeting,...finished}; completed=ui.meeting.status==='completed'; $('recordingState').textContent=completed?'转写已完成':(ui.meeting.warning?'录音已结束 · 有提示':'正在处理录音');
    $('progressWrap').classList.toggle('hidden',ui.meeting.status==='completed'); $('progressText').textContent=ui.meeting.status==='completed'?'转写完成':(ui.meeting.warning || '正在进行本机语音转写…');
    updateView();
    if (ui.meeting.warning) toast(ui.meeting.warning,true);
    await loadHistory();
  } catch(e) { if(operationVersion!==ui.operationVersion)return; await cleanupCapture(); setBusy(false); setOperationError(`结束录音失败：${e.message}`); toast(`结束录音失败：${e.message}`,true); updateView(); }
  finally { if(operationVersion===ui.operationVersion){$('stopButton').disabled=false; setBusy(false); ui.operationStage=''; if(completed) setOperationDone('录音、转写与发言人区分已完成。'); if (ui.meeting?.id===id) { $('recordButton').disabled=false; $('newMeeting').disabled=false; $('chooseAudio').disabled=false; }} }
}

async function transcribeImported() {
  if (!ui.audioQueue.length || ui.busy) return; ui.inferenceStrategy='full'; const version=++ui.operationVersion; setOperation('import','正在转写导入录音'); setBusy(true,'正在转写导入录音'); $('fileMeta').textContent='正在准备音频并启动本机语音识别…';
  try { const files=ui.audioQueue.slice(); const m=await api.transcribeAudio({paths:files.map(file=>file.path),title:$('meetingTitle').value.trim()||$('fileName').textContent,language:$('language').value,model:$('model').value,speakers:Number($('speakers').value),device:selectedDevice(),speakerDevice:selectedSpeakerDevice(),cudaVariant:selectedCudaVariant()}); if(version!==ui.operationVersion)return; ui.meeting=m; updateView(); await loadHistory(); toast('转写完成，可以生成会议纪要'); }
  catch(e) { if(version!==ui.operationVersion)return; $('fileMeta').textContent=e.message; setOperationError(`转写失败：${e.message}`); toast(`转写失败：${e.message}`,true); }
  finally { if(version===ui.operationVersion){setBusy(false);ui.operationStage='';} }
}
async function generateNotes() {
  if (!ui.meeting?.id || ui.busy) return; if (!ui.meeting.segments?.length && !ui.meeting.transcript) return toast('请先完成录音转写',true);
  const id=ui.meeting.id; const version=++ui.operationVersion;
  setOperation('ai','正在请求 AI 生成会议纪要…'); setBusy(true,'正在请求 AI 生成会议纪要…'); $('generateButton').innerHTML='生成中…';
  await flushPendingSave(); if(version!==ui.operationVersion) return;
  try { const generated=await api.generateNotes({id,style:$('style')?.value || '简洁清晰'}); if(version!==ui.operationVersion)return; ui.meeting=generated; updateView(); await saveSnapshot(snapshotForSave(id)); toast('会议纪要已生成'); }
  catch(e) { if(version!==ui.operationVersion)return; setOperationError(`生成失败：${e.message}`); toast(`生成失败：${e.message}`,true); }
  finally { if(version===ui.operationVersion){setBusy(false);ui.operationStage='';$('generateButton').innerHTML=ui.meeting?.summary?'重新生成纪要 <span>→</span>':'生成会议纪要 <span>→</span>'; } }
}
async function autoGenerateNotes(id) {
  if (!id || ui.autoNotesPendingId === id) return;
  ui.autoNotesPendingId = id; ui.autoNotesError = null;
  if (ui.meeting?.id === id) updateView();
  try {
    const generated = await api.generateNotes({ id, style: $('style')?.value || '简洁清晰' });
    if (ui.meeting?.id === id) { ui.meeting = generated; updateView(); toast('会议纪要已生成，发言人区分继续在后台处理'); }
    loadHistory();
  } catch (error) {
    ui.autoNotesError = { id, message: error.message || '自动生成失败' };
    if (ui.meeting?.id === id) { updateView(); toast(`自动生成纪要失败：${ui.autoNotesError.message}`, true); }
  } finally {
    if (ui.autoNotesPendingId === id) ui.autoNotesPendingId = null;
    if (ui.meeting?.id === id) updateView();
  }
}
async function retryMeeting() {
  const id=ui.meeting?.id;
  if (!id || ui.busy || ui.recording || !ui.meeting.audioUrl) return;
  ui.inferenceStrategy='full'; const version=++ui.operationVersion; setOperation('retry','正在重新处理录音…'); setBusy(true,'正在重新处理录音…'); $('retryButton').disabled=true; $('retryButton').textContent='正在重新处理…';
  try { const result=await api.retryMeeting(id,selectedDevice(),selectedCudaVariant(),selectedSpeakerDevice()); if (version!==ui.operationVersion)return; ui.meeting=result; if (ui.meeting?.id===id) { updateView(); await loadHistory(); toast('录音处理完成'); } }
  catch(e) { if(version!==ui.operationVersion)return; try { const latest=await api.getMeeting(id); if (ui.meeting?.id===id) { ui.meeting=latest; updateView(); await loadHistory(); } } catch {} setOperationError(`重新处理失败：${e.message}`); toast(`重新处理失败：${e.message}`,true); }
  finally { if(version===ui.operationVersion){setBusy(false);ui.operationStage='';$('retryButton').disabled=false; $('retryButton').textContent='↻ 重新处理录音';} }
}
async function cancelOperation() {
  if(!ui.busy || ui.recording || ['ai','pick','cancel'].includes(ui.operationStage)) return;
  ++ui.operationVersion; setOperation('cancel','正在取消处理…'); setBusy(true,'正在取消处理…');
  try {
    const result=await api.cancelOperation();
    await cleanupCapture();
    const restored=result?.meeting || (result?.id ? result : null);
    if(restored) ui.meeting=restored;
    setBusy(false); ui.operationStage=''; setOperationDone('处理已取消，已保存的录音和文字仍保留。');
    updateView(); await loadHistory();
  } catch(e) {
    await cleanupCapture(); setBusy(false); ui.operationStage=''; setOperationError(`取消失败：${e.message}`); toast(`取消失败：${e.message}`,true);
  }
}

function appendPartial(event) { const segments=event.segments || []; if (!segments.length) return; ui.partials.push(...segments); if(Number.isFinite(event.processedSeconds))ui.liveRecognizedSeconds=Math.max(ui.liveRecognizedSeconds,event.processedSeconds); $('liveStatus').textContent=`实时转写中 · 已识别到 ${formatTime(ui.liveRecognizedSeconds)} / ${formatTime(ui.seconds)}`; $('liveTranscript').innerHTML=ui.partials.slice(-30).map(s=>`<p>${escapeHtml(s.speaker?`发言人 ${String(s.speaker).replace('speaker_','')}：`:'' )}${escapeHtml(s.text || '')}</p>`).join(''); $('liveTranscript').scrollTop=$('liveTranscript').scrollHeight; }
function paintLiveTranscript() {
  const fragment=document.createDocumentFragment();
  for(const item of ui.liveCommitted.slice(-30)){const line=document.createElement('p');line.textContent=`${item.speaker?`发言人 ${String(item.speaker).replace('speaker_','')}：`:''}${item.text}`;fragment.appendChild(line);}
  if(ui.liveDraft){const draft=document.createElement('p');draft.className='live-interim';draft.textContent=`${ui.liveDraftSpeaker?`发言人 ${String(ui.liveDraftSpeaker).replace('speaker_','')}：`:''}${ui.liveDraft}`;fragment.appendChild(draft);}
  $('liveTranscript').replaceChildren(fragment); $('liveTranscript').scrollTop=$('liveTranscript').scrollHeight;
}
function liveSpeakerFor(start,end) {
  const scores={};
  for(const turn of ui.liveSpeakerTurns){const overlap=Math.max(0,Math.min(end,turn.end)-Math.max(start,turn.start));if(overlap>0)scores[turn.speaker]=(scores[turn.speaker]||0)+overlap;}
  return Object.entries(scores).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
}
function renderLiveHypothesis(event) {
  if (event.final) { if (event.text) ui.liveCommitted.push({text:event.text,speaker:event.speaker||liveSpeakerFor(event.start,event.end),start:event.start,end:event.end}); ui.liveDraft=''; ui.liveDraftSpeaker=''; }
  else ui.liveDraft=event.text||'';
  paintLiveTranscript();
  if(event.final&&event.speaker) $('liveSpeakerStatus').textContent=`已匹配 ${String(event.speaker).replace('speaker_','发言人 ')}`;
  if(Number.isFinite(event.end))ui.liveRecognizedSeconds=Math.max(ui.liveRecognizedSeconds,event.end);
  $('liveStatus').textContent=`${event.final?'实时识别 · ':'正在听写 · '}已识别到 ${formatTime(ui.liveRecognizedSeconds)} / ${formatTime(ui.seconds)}`;
}
function onMeetingEvent(payload) {
  if (!payload || (payload.id && ui.meeting?.id && payload.id!==ui.meeting.id)) return;
  if (payload.event==='ready') { clearStartupProgress(); return; }
  if (payload.event==='live-ready') { ui.liveAsrReady=true; $('liveStatus').textContent='麦克风已连接 · 正在实时识别'; $('liveSpeakerStatus').textContent='声纹模型准备中'; return; }
  if (payload.event==='live-speaker-ready') { ui.liveSpeakerReady=true; $('liveSpeakerStatus').textContent='边录边匹配发言人'; return; }
  if (payload.event==='live-aux-ready') { clearStartupProgress(); if(!ui.liveSpeakerReady)$('liveSpeakerStatus').textContent='实时声纹暂不可用'; return; }
  if (payload.event==='live-error') { if(payload.fatal){ui.liveAsrReady=false;if(payload.message)$('liveStatus').textContent=payload.message;} else if(payload.message?.includes('实时声纹')) $('liveSpeakerStatus').textContent='实时声纹模型准备失败'; return; }
  if (payload.event==='live-hypothesis') { if(ui.liveAsrReady)renderLiveHypothesis(payload); return; }
  if (payload.event==='live-speaker-preview') { ui.liveDraftSpeaker=payload.speaker||''; setWaveformSpeaker(payload.speaker); if(ui.liveDraft)paintLiveTranscript(); if(payload.speaker)$('liveSpeakerStatus').textContent=`正在匹配 ${String(payload.speaker).replace('speaker_','发言人 ')}`; return; }
  if (payload.event==='live-speaker-turn') { ui.liveSpeakerTurns.push({speaker:payload.speaker,start:Number(payload.start),end:Number(payload.end)}); setWaveformSpeaker(payload.speaker); for(const item of ui.liveCommitted)item.speaker=liveSpeakerFor(item.start,item.end)||item.speaker; paintLiveTranscript(); if(payload.speaker)$('liveSpeakerStatus').textContent=`已匹配 ${String(payload.speaker).replace('speaker_','发言人 ')}`; return; }
  if (payload.event==='partial') {
    if(!ui.liveAsrReady)appendPartial(payload);
    const processed=Number.isFinite(payload.processedSeconds)?payload.processedSeconds:payload.processed;
    if(ui.operationStage==='finalize'&&ui.inferenceStrategy==='fast'&&Number.isFinite(processed))showInferenceProgress({stage:'refine',message:'正在补齐末尾转写',processedSeconds:processed,totalSeconds:Number(ui.meeting?.duration)||ui.seconds,elapsed:Number(ui.inferenceData?.elapsed)||0,eta:payload.eta,audioSpeed:payload.audioSpeed});
  }
  else if (payload.event==='progress' && payload.stage==='live-transcribe') {
    const processed=Number(payload.processedSeconds)||0,total=Number(payload.totalSeconds)||0,percent=total?Math.min(100,Math.round(processed/total*100)):0;
    const eta=Number.isFinite(payload.eta)?` · 本段约剩 ${formatTime(payload.eta)}`:'';
    $('liveStatus').textContent=`本机正在识别当前片段 · ${percent}%${eta}`;
  }
  else if (payload.event==='progress' && startupStages[payload.stage]) showStartupProgress(payload);
  else if (payload.event==='progress' && ['transcribe','refine','finish-transcript','speakers'].includes(payload.stage)) showInferenceProgress(payload);
  else if (payload.event==='progress' && payload.stage==='merge-audio') showMergeProgress(payload);
  else if (payload.event==='progress') { const message=payload.message || payload.stage || (payload.processed ? `已处理 ${payload.processed}` : '正在处理…'); $('operationText').textContent=message; $('progressWrap').classList.remove('hidden'); $('progressText').textContent=message; }
  else if (payload.event==='state') { if (payload.message) { $('liveStatus').textContent=payload.message; if(ui.busy)$('operationText').textContent=payload.message; } if (payload.stage) $('progressText').textContent=payload.stage; }
  else if (payload.event==='transcribed' && payload.meeting) { ui.meeting=payload.meeting; updateView(); if(ui.busy){$('operationText').textContent='逐字稿已就绪，正在生成纪要…'; $('inferenceProgressLabel').textContent='正在生成会议纪要';} loadHistory(); void autoGenerateNotes(payload.meeting.id); }
  else if (payload.event==='error') { setBusy(false); setOperationError(payload.message || '处理失败'); toast(payload.message || '处理失败',true); if(ui.meeting){ui.meeting.status='failed';ui.meeting.warning=payload.message;updateView();} loadHistory(); }
  else if (payload.event==='result' && payload.meeting) { ui.meeting=payload.meeting; ui.recording=false; setBusy(false); $('progressWrap').classList.add('hidden'); updateView(); loadHistory(); toast(payload.meeting.summary?'会议纪要已生成':'转写完成，正在生成会议纪要'); }
}

$('recordButton').addEventListener('click',startRecording); $('stopButton').addEventListener('click',stopRecording); $('newMeeting').addEventListener('click',resetMeeting); $('workspaceNav').addEventListener('click',resetMeeting);
$('chooseAudio').addEventListener('click',pickAudio); $('removeAudio').addEventListener('click',()=>{if(ui.busy||ui.recording)return;ui.audio=null;ui.audioQueue=[];$('transcribeButton').disabled=true;renderAudioQueue();$('importFile').classList.add('hidden');syncPlayback();$('emptyState').classList.remove('hidden');}); $('audioQueueList').addEventListener('click',event=>{if(ui.busy||ui.recording)return;const button=event.target.closest('button');if(!button)return;const index=Number(button.dataset.audioUp??button.dataset.audioDown??button.dataset.audioRemove);if(!Number.isInteger(index)||index<0||index>=ui.audioQueue.length)return;if(button.dataset.audioRemove!==undefined)ui.audioQueue.splice(index,1);else {const target=button.dataset.audioUp!==undefined?index-1:index+1;if(target<0||target>=ui.audioQueue.length)return;[ui.audioQueue[index],ui.audioQueue[target]]=[ui.audioQueue[target],ui.audioQueue[index]];}if(!ui.audioQueue.length){ui.audio=null;$('transcribeButton').disabled=true;$('importFile').classList.add('hidden');$('emptyState').classList.remove('hidden');}else selectAudio(ui.audioQueue.slice());renderAudioQueue();syncPlayback();}); $('transcribeButton').addEventListener('click',transcribeImported); $('generateButton').addEventListener('click',generateNotes); $('cancelOperationButton').addEventListener('click',cancelOperation); $('dismissOperation').addEventListener('click',()=>$('operationBar').classList.add('hidden'));
$('notesEditor').addEventListener('input',()=>{if(ui.meeting){ui.meeting.notes=$('notesEditor').value;scheduleSave();syncPosterButton();}}); $('saveButton').addEventListener('click',()=>saveSnapshot(snapshotForSave(ui.meeting?.id),false));
$('renameSpeakers').addEventListener('click',()=>{const editor=$('speakerEditor');editor.dataset.open=editor.dataset.open==='true'?'false':'true';renderSpeakers();});
$('playAudioButton').addEventListener('click',()=>{const player=$('audioPlayer'); if(!player.paused && !player.ended) player.pause(); else { if(player.ended) player.currentTime=0; player.play().catch(reportPlaybackError); }});
$('playbackSeek').addEventListener('input',e=>{const player=$('audioPlayer'); if(Number.isFinite(player.duration)) player.currentTime=Number(e.target.value);});
for (const event of ['loadedmetadata','durationchange','timeupdate','seeked']) $('audioPlayer').addEventListener(event,updatePlaybackProgress);
for (const event of ['play','pause','ended']) $('audioPlayer').addEventListener(event,updatePlaybackState);
$('retryButton').addEventListener('click',retryMeeting);
$('exportButton').addEventListener('click',async()=>{const m=ui.meeting;if(!m)return;const transcript=(m.segments||[]).map(s=>`[${formatTime(s.start)}] **${s.speaker?(m.speakerNames?.[s.speaker]||s.speaker):'未区分'}**：${s.text}`).join('\n');const todos=(m.todos||[]).map(t=>`- [${t.done?'x':' '}] ${t.title}${t.owner?`（负责人：${t.owner}）`:''}${t.due?`（时间：${t.due}）`:''}`).join('\n');const content=`# ${m.title||'会议纪要'}\n\n> ${formatDate(m.date)} · ${formatDuration(m.duration)}\n\n## 会议摘要\n\n${m.summary||'（尚未生成）'}\n\n## 讨论重点\n\n${(m.highlights||[]).map(x=>`- ${x}`).join('\n')||'（尚未生成）'}\n\n## 待办事项\n\n${todos||'（尚未生成）'}\n\n## 会议纪要\n\n${$('notesEditor').value||m.notes||'（待补充）'}\n\n## 发言人逐字稿\n\n${transcript||m.transcript||'（暂无逐字稿）'}\n`;try{const path=await api.saveFile({content,suggestedName:`${m.title||'会议纪要'}.md`});if(path)toast('纪要已导出');}catch(e){toast(`导出失败：${e.message}`,true);}});
let posterDataUrls = [];
let posterTitle = '';
let posterToken = 0;
let posterBusy = false;
function syncPosterButton() {
  const button = $('posterButton');
  const hasContent = hasPosterContent();
  button.disabled = !hasContent || ui.busy || posterBusy;
  button.title = ui.busy ? '当前会议处理完成后可生成图片' : hasContent ? '根据当前会议纪要生成信息图' : '先添加摘要、会议纪要、重点或待办后再生成图片';
  if (!posterBusy) button.innerHTML = '生成图片 <span>✦</span>';
}
function hasPosterContent() {
  const meeting = ui.meeting;
  if (!meeting) return false;
  const notes = $('notesEditor').value;
  return !!(String(meeting.summary || '').trim() || String(notes).trim() || (meeting.highlights || []).some(item => String(item || '').trim()) || (meeting.todos || []).some(todo => String(todo?.title || '').trim()));
}
async function generatePoster(title) {
  const m = ui.meeting;
  if (!m || !hasPosterContent() || ui.busy || posterBusy) return;
  const safeTitle=String(title||'').trim().slice(0,120);
  if(!safeTitle)return toast('图片标题不能为空。',true);
  posterBusy = true;
  const token = ++posterToken, meetingId = m.id;
  posterTitle=safeTitle;
  $('posterTitleInput').value=safeTitle;
  $('posterTitleInput').disabled=true;
  $('applyPosterTitle').disabled=true;
  const button = $('posterButton'); button.disabled = true; button.textContent = '生成中…';
  $('savePosterButton').disabled = true;
  posterDataUrls=[];
  $('posterPreview').innerHTML = '<div class="poster-loading">正在生成图片…</div>';
  $('posterModal').classList.remove('hidden');
  try {
    await flushPendingSave();
    const images = await api.createMeetingPoster({ id: meetingId, title: safeTitle });
    if (!images?.length) throw new Error('图片生成失败');
    if (token !== posterToken || ui.meeting?.id !== meetingId) return;
    posterDataUrls = images;
    const fragment = document.createDocumentFragment();
    images.forEach((data, index) => {
      const page = document.createElement('div'); page.className = 'poster-page-preview';
      const label = document.createElement('div'); label.className = 'poster-page-label'; label.textContent = images.length > 1 ? `第 ${index + 1} / ${images.length} 页` : 'PNG 图片';
      const img = document.createElement('img'); img.className = 'poster-image'; img.alt = `${safeTitle} 图片预览，第 ${index + 1} 页`; img.loading = 'lazy'; img.decoding = 'async'; img.src = data;
      page.append(label, img); fragment.append(page);
    });
    $('posterPreview').replaceChildren(fragment);
    $('posterCaption').textContent = `PNG · ${images.length} 张 · 简体中文`;
    $('savePosterButton').disabled = false;
  } catch (error) {
    if (token !== posterToken) return;
    $('posterPreview').innerHTML = `<div class="poster-error">${escapeHtml(error.message || '生成失败')}<br><button class="quiet-button" id="retryPoster">重试</button></div>`;
    $('retryPoster').addEventListener('click', () => generatePoster($('posterTitleInput').value));
    toast(`图片生成失败：${error.message}`, true);
  } finally {
    posterBusy = false;
    if(token===posterToken){$('posterTitleInput').disabled=false; $('applyPosterTitle').disabled=false;}
    syncPosterButton();
  }
}
$('posterButton').addEventListener('click', () => {
  const m=ui.meeting;
  if(!m||!hasPosterContent()||ui.busy||posterBusy)return;
  const title=String(m.title||'会议纪要').trim();
  $('posterModal').classList.remove('hidden');
  void generatePoster(title);
});
$('applyPosterTitle').addEventListener('click',()=>{
  if(posterBusy)return;
  const title=$('posterTitleInput').value;
  if(title.trim()===posterTitle&&posterDataUrls.length)return;
  void generatePoster(title);
});
$('posterTitleInput').addEventListener('keydown',event=>{if(event.key==='Enter')$('applyPosterTitle').click();});
$('savePosterButton').addEventListener('click', async () => {
  if (!posterDataUrls.length || !ui.meeting || posterBusy) return;
  const pages = posterDataUrls.slice(), meetingId = ui.meeting.id, token = posterToken;
  $('savePosterButton').disabled = true;
  try {
    let saved = 0, cancelled = false;
    for (let i = 0; i < pages.length; i++) {
      if (token !== posterToken || ui.meeting?.id !== meetingId) break;
      const suffix = pages.length > 1 ? `-${String(i + 1).padStart(2, '0')}` : '';
      const file = await api.savePoster({ dataUrl: pages[i], suggestedName: `${posterTitle || ui.meeting.title || '会议纪要'}${suffix}.png` });
      if (!file) { cancelled = true; break; }
      saved++;
    }
    if (cancelled && saved > 0) toast(`已保存 ${saved} 张，后续页面已取消`);
    else if (saved === pages.length && saved > 0) toast(`已保存 ${saved} 张图片`);
  }
  catch (error) { toast(`保存图片失败：${error.message}`, true); }
  finally { if (token === posterToken) $('savePosterButton').disabled = !posterDataUrls.length; }
});
function closePoster() { posterToken++; posterDataUrls = []; posterTitle=''; $('savePosterButton').disabled = true; $('posterModal').classList.add('hidden'); syncPosterButton(); }
$('closePoster').addEventListener('click', closePoster); $('posterModal').addEventListener('click', e => { if (e.target === $('posterModal')) closePoster(); });
$('historySearch').addEventListener('input',()=>{clearTimeout(ui.queryTimer);ui.queryTimer=setTimeout(()=>loadHistory(),180);});
function syncBalanceVisibility(){const shown=$('apiProvider').value==='deepseek';$('deepseekBalance').classList.toggle('hidden',!shown);if(shown){$('deepseekBalanceStatus').textContent=$('apiKey').value.trim()?'点击刷新以查询余额':'请先配置 DeepSeek API 密钥';$('deepseekBalanceStatus').className=$('apiKey').value.trim()?'':'balance-status-error';$('deepseekBalanceDetails').replaceChildren();}}
async function loadProviderSettings(provider) { const c=await api.getSettings(provider); $('apiProvider').value=c.provider; $('apiEndpoint').value=c.endpoint||''; $('apiModel').value=c.model||''; $('apiKey').value=c.apiKey||''; $('settingsStatus').textContent=c.apiKey?'已配置':'仅在生成纪要时使用'; syncBalanceVisibility(); }
function showSettings() { if(ui.busy||ui.recording)return; api.getSettings().then(c=>{ $('settingsModal').classList.remove('hidden'); return loadProviderSettings(c.activeProvider); }).catch(e=>toast(e.message,true)); }
 $('apiProvider').addEventListener('change',()=>loadProviderSettings($('apiProvider').value).catch(e=>toast(e.message,true)));
$('refreshDeepSeekBalance').addEventListener('click',async()=>{const button=$('refreshDeepSeekBalance'),status=$('deepseekBalanceStatus'),details=$('deepseekBalanceDetails');if(!$('apiKey').value.trim()){status.textContent='请先配置 DeepSeek API 密钥';status.className='balance-status-error';details.replaceChildren();return;}button.disabled=true;button.textContent='查询中…';status.textContent='正在查询账户余额…';status.className='';details.replaceChildren();try{const balance=await api.getDeepSeekBalance();status.textContent=balance.is_available?'账户可用':'账户暂不可用';status.className=balance.is_available?'balance-status-ok':'balance-status-error';for(const item of balance.balance_infos){const currency=document.createElement('div');currency.textContent=item.currency;currency.className='balance-row';details.append(currency);for(const [label,key] of [['总余额','total_balance'],['赠余额','granted_balance'],['充值余额','topped_up_balance']]){const row=document.createElement('div'),name=document.createElement('span'),value=document.createElement('span');row.className='balance-row';name.textContent=label;value.textContent=`${item[key]} ${item.currency}`;row.append(name,value);details.append(row);}}if(!balance.balance_infos.length){details.textContent='暂无余额信息';}}catch(error){status.textContent=error.message||'查询余额失败，请重试';status.className='balance-status-error';}finally{button.disabled=false;button.textContent='刷新余额';}});
$('openSettings').addEventListener('click',showSettings); $('headerSettings').addEventListener('click',showSettings); $('closeSettings').addEventListener('click',()=>$('settingsModal').classList.add('hidden')); $('settingsModal').addEventListener('click',e=>{if(e.target===$('settingsModal'))$('settingsModal').classList.add('hidden');});
$('saveSettings').addEventListener('click',async()=>{const config={provider:$('apiProvider').value,endpoint:$('apiEndpoint').value.trim(),model:$('apiModel').value.trim(),apiKey:$('apiKey').value.trim()};try{await api.saveSettings(config);$('settingsStatus').textContent='设置已保存在本机';syncBalanceVisibility();toast('AI 服务设置已保存');}catch(e){$('settingsStatus').textContent=e.message;toast(`保存失败：${e.message}`,true);}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('historySearch').focus();}});
document.addEventListener('dragover',e=>{if(!ui.busy&&!ui.recording)e.preventDefault();}); document.addEventListener('drop',async e=>{e.preventDefault();if(ui.busy||ui.recording)return;const files=Array.from(e.dataTransfer?.files||[]);if(files.length){await resetMeeting();await selectAudio(files);}});
ui.eventOff=api.onMeetingEvent(onMeetingEvent); ui.stopOff=api.onRequestStop(stopRecording); loadGpuCapability(); loadHistory(); updateView();
api.onPrepareClose(async () => {
  try { await flushPendingSave(); api.confirmClose({ok:true}); }
  catch (error) { api.confirmClose({ok:false,message:error.message}); }
});
