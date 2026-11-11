'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true,
  platform: process.platform,
  setBadge: (count) => ipcRenderer.send('set-badge', count),
  showNotification: (payload) => ipcRenderer.invoke('show-notification', payload),
  // 应用内更新（electron/updater.js）
  updater: {
    getState: () => ipcRenderer.invoke('updater:get-state'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    openDownloaded: () => ipcRenderer.invoke('updater:open-downloaded'),
    revealDownloaded: () => ipcRenderer.invoke('updater:reveal-downloaded'),
    openRelease: () => ipcRenderer.invoke('updater:open-release'),
    onStateChange: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('updater:state', listener);
      return () => ipcRenderer.removeListener('updater:state', listener);
    }
  }
});
