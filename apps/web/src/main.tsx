import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router.js';
import './index.css';
import { LocaleProvider } from './i18n/LocaleProvider.js';

// The open-source app runs fully anonymous: share the room code and
// anyone joins. No auth wiring — room creation, messaging, and reports
// all work without a sign-in.
const root = ReactDOM.createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    <LocaleProvider>
      <RouterProvider router={router} />
    </LocaleProvider>
  </React.StrictMode>
);
