import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('selene', {
  platform: process.platform
});
