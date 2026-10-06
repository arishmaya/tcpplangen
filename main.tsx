import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppSelector from './AppSelector.tsx';
import 'leaflet/dist/leaflet.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppSelector />
  </StrictMode>,
);
