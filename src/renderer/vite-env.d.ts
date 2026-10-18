/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface SerializedFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

interface DialerAPI {
  uploadAssistantScreenshot?: (payload: { agentId: number; requestId: string; filename: string; base64: string; token: string }) => Promise<SerializedFetchResponse>;
  readAssistantScreenshot?: (payload: { agentId: number; recordId: string; token: string }) => Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; base64: string; contentType: string; errorBody?: string }>;
  macConnectors?: {
    status: () => Promise<unknown>;
    requestAccess: (connector: 'contacts' | 'messages') => Promise<unknown>;
    searchContacts: (query: string) => Promise<unknown>;
    previewContactDuplicates: () => Promise<unknown>;
    prepareContactChange: (payload: unknown) => Promise<unknown>;
    executeContactChange: (binding: unknown) => Promise<unknown>;
    listMessageThreads: (query: string) => Promise<unknown>;
    readMessageThread: (threadId: string) => Promise<unknown>;
    prepareMessageSend: (payload: unknown) => Promise<unknown>;
    executeMessageSend: (binding: unknown) => Promise<unknown>;
    restoreReviewedWrite: (payload: unknown) => Promise<unknown>;
    listReviewedWrites: (payload: unknown) => Promise<unknown>;
    reconcileReviewedWrite: (payload: unknown) => Promise<unknown>;
    searchWhatsApp: (query: string) => Promise<unknown>;
    prepareSmsDraft: (payload: unknown) => Promise<unknown>;
    openSmsDraft: (binding: unknown) => Promise<unknown>;
    monitorState: (payload: unknown) => Promise<unknown>;
    resumeMonitor: (payload: unknown) => Promise<unknown>;
    startMonitor: (payload: unknown) => Promise<unknown>;
    stopMonitor: (payload: unknown) => Promise<unknown>;
    refreshMonitor: (payload: unknown) => Promise<unknown>;
    onMonitorState: (callback: () => void) => () => void;
  };
  readonly nativeWindowControls?: boolean;
  readonly initialWorkspace?: 'assistant' | 'dialer';
  uploadRecordingSegment?: (payload: { contactId: number; sessionId: string; sequence: number; authorization: string; audio: ArrayBuffer; mimeType: string; startOffsetMs: number; endOffsetMs: number }) => Promise<SerializedFetchResponse>;
  downloadRecordingAudio?: (payload: { contactId: number; sessionId: string; sequence: number; authorization: string }) => Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; body: ArrayBuffer; errorBody?: string }>;
  openExternal?: (url: string) => Promise<void>;
  openBrochure?: (planId: string) => Promise<void>;
  clearAssistant?: () => Promise<void>;
  compassRequest?: (operation: 'plans' | 'chat', payload?: unknown) => Promise<unknown>;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  showWindow: () => Promise<void>;
  windowResize?: (mode: 'full' | 'compact') => Promise<void>;
  apiFetch?: (url: string, options?: ApiFetchOptions) => Promise<SerializedFetchResponse>;
}

interface Window {
  dialer: DialerAPI;
}
