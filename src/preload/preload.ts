import { contextBridge, ipcRenderer } from 'electron';

interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

contextBridge.exposeInMainWorld('dialer', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
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
