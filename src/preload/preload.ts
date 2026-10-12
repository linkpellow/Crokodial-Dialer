import { contextBridge, ipcRenderer } from 'electron';

interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

contextBridge.exposeInMainWorld('dialer', {
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openBrochure: (planId: string) => ipcRenderer.invoke('compass-brochure', planId),
  clearAssistant: () => ipcRenderer.invoke('compass-clear'),
  compassRequest: (operation: 'plans' | 'chat', payload?: unknown) => ipcRenderer.invoke('compass-request', operation, payload),
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  showWindow: () => ipcRenderer.invoke('window-show'),
  windowResize: (mode: 'full' | 'compact') => ipcRenderer.invoke('window-resize', mode),
  apiFetch: (url: string, options?: ApiFetchOptions) =>
    ipcRenderer.invoke('api-fetch', {
      url,
      method: options?.method,
      headers: options?.headers,
      body: options?.body,
    }),
});
