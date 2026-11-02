// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  HashRouter,
  Route,
  Routes,
} from 'react-router';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

import CgIdHome from 'cgid/home';
import CgIdCreatePasskey from 'cgid/createPasskey';
import CgIdLogin from 'cgid/login';
import urlConfig from './data/util/urls';

import "./index_cgid.css";

// IMPORTANT!
// Since this is intended to become its own repository, make sure not to import
// dependencies that will start their own connection things, like the `connectionManager`

function App() {
  const loadingScreenHiddenRef = React.useRef(false);

  const hideLoadingScreen = React.useCallback(() => {
    if (loadingScreenHiddenRef.current === false) {
      const loadingScreenDiv = document.getElementById("loading-screen");
      if (loadingScreenDiv) {
        loadingScreenHiddenRef.current = true;
        loadingScreenDiv.ontransitionend = () => {
          loadingScreenDiv.style.display = "none";
        };
        loadingScreenDiv.style.opacity = "0";
      }
    }
  }, []);

  if (!browserSupportsWebAuthn()) {
    return (
      <>
        <div className="cgid-header">
          <div><img src={`${urlConfig.APP_URL}/icons/128.png`} /></div>
          <div>CG ID</div>
        </div>

        <div className='cgid-info'>
          <div>Error: Your browser does not support passkeys.</div>
        </div>
      </>
    );
  }

  return (
    <Routes>
      <Route path='/' element={<CgIdHome hideLoadingScreen={hideLoadingScreen} />} />
      <Route path='/create/:frontendRequestId' element={<CgIdCreatePasskey hideLoadingScreen={hideLoadingScreen} />} />
      <Route path='/login/:frontendRequestId' element={<CgIdLogin hideLoadingScreen={hideLoadingScreen} />} />
    </Routes>
  )
}

if (urlConfig.I_AM_CGID === true) {
  // temporary solution to fix the main ui from loading this entry point

  const root = createRoot(document.getElementById('app-root') as HTMLElement);

  root.render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>
  );
}
