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
