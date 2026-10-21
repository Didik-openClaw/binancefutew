import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { fontsReady } from './fonts';
import './styles.css';

void fontsReady();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
