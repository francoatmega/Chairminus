'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['menu', 'log', 'session:state', 'transfer:progress', 'settings:changed', 'connections:changed', 'open-sql-file']);

contextBridge.exposeInMainWorld('bridge', {
  platform: process.platform,
  /** Resolves to {ok:true,value} or {ok:false,error,need?}; the renderer unwraps it. */
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event: ${channel}`);
    const wrapped = (event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
