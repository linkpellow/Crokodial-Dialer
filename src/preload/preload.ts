import { contextBridge, ipcRenderer } from 'electron';

interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

contextBridge.exposeInMainWorld('dialer', {
  nativeWindowControls: process.platform === 'darwin',
  initialWorkspace: process.argv.includes('--workspace=assistant') ? 'assistant' : 'dialer',
  uploadRecordingSegment: (payload: unknown) => ipcRenderer.invoke('recording-upload-segment', payload),
  downloadRecordingAudio: (payload: unknown) => ipcRenderer.invoke('recording-download-audio', payload),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  uploadAssistantScreenshot: (payload: unknown) => ipcRenderer.invoke('assistant-screenshot-upload', payload),
  readAssistantScreenshot: (payload: unknown) => ipcRenderer.invoke('assistant-screenshot-read', payload),
  macConnectors: {
    status: () => ipcRenderer.invoke('mac-connectors-status'),
    requestAccess: (connector: 'contacts' | 'messages') => ipcRenderer.invoke('mac-connectors-request-access', connector),
    searchContacts: (query: string) => ipcRenderer.invoke('mac-contacts-search', query),
    previewContactDuplicates: () => ipcRenderer.invoke('mac-contacts-dedupe-preview'),
    prepareContactChange: (payload: unknown) => ipcRenderer.invoke('mac-contacts-prepare-change', payload),
    executeContactChange: (binding: unknown) => ipcRenderer.invoke('mac-contacts-execute-change', binding),
    listMessageThreads: (query: string) => ipcRenderer.invoke('mac-messages-list-threads', query),
    readMessageThread: (threadId: string) => ipcRenderer.invoke('mac-messages-read-thread', threadId),
    prepareMessageSend: (payload: unknown) => ipcRenderer.invoke('mac-messages-prepare-send', payload),
    executeMessageSend: (binding: unknown) => ipcRenderer.invoke('mac-messages-execute-send', binding),
    restoreReviewedWrite: (payload: unknown) => ipcRenderer.invoke('mac-reviewed-write-restore', payload),
    listReviewedWrites: (payload: unknown) => ipcRenderer.invoke('mac-reviewed-write-list', payload),
    reconcileReviewedWrite: (payload: unknown) => ipcRenderer.invoke('mac-reviewed-write-reconcile', payload),
    searchWhatsApp: (query: string) => ipcRenderer.invoke('mac-whatsapp-search', query),
    prepareSmsDraft: (payload: unknown) => ipcRenderer.invoke('mac-sms-prepare-draft', payload),
    openSmsDraft: (binding: unknown) => ipcRenderer.invoke('mac-sms-open-draft', binding),
    monitorState: (payload: unknown) => ipcRenderer.invoke('mac-monitor-state', payload),
    resumeMonitor: (payload: unknown) => ipcRenderer.invoke('mac-monitor-resume', payload),
    startMonitor: (payload: unknown) => ipcRenderer.invoke('mac-monitor-start', payload),
    stopMonitor: (payload: unknown) => ipcRenderer.invoke('mac-monitor-stop', payload),
    refreshMonitor: (payload: unknown) => ipcRenderer.invoke('mac-monitor-refresh', payload),
    onMonitorState: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('mac-monitor-state-changed', listener);
      return () => ipcRenderer.removeListener('mac-monitor-state-changed', listener);
    },
  },
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
