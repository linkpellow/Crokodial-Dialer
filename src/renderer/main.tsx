import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ScaleContainer } from '@/renderer/components/ScaleContainer';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <div className={window.dialer?.nativeWindowControls ? 'native-window-frame' : 'h-full'}>
      {window.dialer?.nativeWindowControls && <div className="native-window-titlebar" aria-hidden="true" />}
      <div className="native-window-content">
        <ScaleContainer topInset={window.dialer?.nativeWindowControls ? 32 : 0}>
          <App />
        </ScaleContainer>
      </div>
    </div>
  </React.StrictMode>
);
