const { contextBridge, ipcRenderer } = require('electron');

// Deliberately expose only a tiny, typed desktop-control API. The renderer never receives
// ipcRenderer itself, filesystem access, API keys, or Node integration.
contextBridge.exposeInMainWorld('contexaDesktop', {
  getStatus: () => ipcRenderer.invoke('contexa:get-status'),
  enableAutoCapture: () => ipcRenderer.invoke('contexa:enable-auto-capture'),
  pauseAutoCapture: () => ipcRenderer.invoke('contexa:pause-auto-capture'),
  onTranscript: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('contexa:transcript', listener);
    return () => ipcRenderer.removeListener('contexa:transcript', listener);
  },
});
