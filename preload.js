const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  requestMicrophonePermission: () => ipcRenderer.invoke('record:request-microphone'),
  startRecording: (options) => ipcRenderer.invoke('record:start', options),
  getNvidiaGpu: () => ipcRenderer.invoke('gpu:detect'),
  sendAudio: ({ id, pcm }) => ipcRenderer.send('record:audio', { id, pcm }),
  stopRecording: (options) => ipcRenderer.invoke('record:stop', options),
  openAudio: () => ipcRenderer.invoke('audio:open'),
  transcribeAudio: (options = {}) => ipcRenderer.invoke('audio:transcribe', Array.isArray(options) ? { paths: options } : options),
  listHistory: (options = {}) => ipcRenderer.invoke('history:list', options),
  deleteMeeting: (id) => ipcRenderer.invoke('history:delete', id),
  getMeeting: (id) => ipcRenderer.invoke('history:get', id),
  retryMeeting: (id, device, cudaVariant, speakerDevice) => ipcRenderer.invoke('history:retry', { id, device, cudaVariant, speakerDevice }),
  cancelOperation: () => ipcRenderer.invoke('operation:cancel'),
  confirmClose: (result) => ipcRenderer.send('app:close-ready', result),
  requestClose: () => ipcRenderer.send('app:request-close'),
  onPrepareClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:prepare-close', listener);
    return () => ipcRenderer.removeListener('app:prepare-close', listener);
  },
  saveMeeting: (meeting) => ipcRenderer.invoke('history:save', meeting),
  getSettings: (provider) => ipcRenderer.invoke('settings:get', provider),
  saveSettings: (config) => ipcRenderer.invoke('settings:save', config),
  getDeepSeekBalance: () => ipcRenderer.invoke('deepseek:balance'),
  generateNotes: (options) => ipcRenderer.invoke('notes:generate', options),
  saveFile: (data) => ipcRenderer.invoke('file:save', data),
  createMeetingPoster: (meeting) => ipcRenderer.invoke('poster:create', meeting),
  savePoster: (data) => ipcRenderer.invoke('poster:save', data),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onMeetingEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('meeting:event', listener);
    return () => ipcRenderer.removeListener('meeting:event', listener);
  },
  onRequestStop: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('record:request-stop', listener);
    return () => ipcRenderer.removeListener('record:request-stop', listener);
  }
});
