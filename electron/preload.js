'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true,
  setBadge: (count) => ipcRenderer.send('set-badge', count),
  showNotification: (payload) => ipcRenderer.invoke('show-notification', payload)
});
