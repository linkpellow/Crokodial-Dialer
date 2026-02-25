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
    <ScaleContainer>
      <App />
    </ScaleContainer>
  </React.StrictMode>
);
