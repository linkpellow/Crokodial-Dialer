/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_TELNYX_WEBRTC_USERNAME?: string;
  readonly VITE_TELNYX_WEBRTC_PASSWORD?: string;
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
  minimize: () => Promise<void>;
  close: () => Promise<void>;
  showWindow: () => Promise<void>;
  windowResize?: (mode: 'full' | 'compact') => Promise<void>;
  apiFetch?: (url: string, options?: ApiFetchOptions) => Promise<SerializedFetchResponse>;
}

interface Window {
  dialer: DialerAPI;
}
