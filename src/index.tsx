// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

window.onload = async () => {
  /* async imports */

  const [
    { useEffect, startTransition, lazy, useState, StrictMode, useRef, Component, useCallback },
    { createRoot },
    { ConnectionProvider, useConnectionContext },
    { default: config }
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('context/ConnectionProvider'),
    import('./common/config')
  ]);

  const GlobalDictionaryProvider = lazy(() => import('./context/GlobalDictionaryProvider').then(module => ({ default: module.GlobalDictionaryProvider })));
  const [Router, preloadRouter] = ((importFn) => [lazy(importFn), () => importFn()])(() => import('./components/SuspenseRouter/SuspenseRouter'));
  const [App, preloadApp] = ((importFn) => [lazy(importFn), () => importFn()])(() => import('./App'));

  /* html element setup */

  const deferredPwaPrompt: {
    prompt: null | Event;
    onchange: (e: Event) => void;
  } = {
    prompt: null as null | Event,
    onchange: () => undefined,
  };
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPwaPrompt.prompt = e;
    deferredPwaPrompt.onchange(e);
  });
  (window as any).__deferredPwaPrompt = deferredPwaPrompt;

  const previewDiv = document.getElementById("cg-preview") as HTMLElement;
  const statusDiv = document.getElementById("cg-preview-status") as HTMLElement;
  const buttonDiv = document.getElementById("cg-preview-btn-container") as HTMLElement;
  const progressBarDiv = document.getElementById("cg-preview-progress") as HTMLElement;
  const progressContainerDiv = document.getElementById("cg-preview-progress-container") as HTMLElement;
  const logoDiv = document.getElementById("cg-preview-logo-svg") as HTMLElement;

  let transitionInProgress = false;
  const nextTransitions: string[] = [];
  function setStatusText(text: string) {
    if (statusDiv.textContent !== text && (nextTransitions.length === 0 || nextTransitions[nextTransitions.length-1] !== text)) {
      if (transitionInProgress === true) {
        nextTransitions.push(text);
      } else {
        statusDiv.ontransitioncancel = () => {
          transitionInProgress = false;
          nextTransitions.splice(0);
          statusDiv.style.opacity = "1.0";
          statusDiv.innerHTML = text;
        }
        if (parseFloat(statusDiv.style.opacity || "0") === 1) {
          statusDiv.ontransitionend = () => {
            statusDiv.ontransitionend = () => {
              transitionInProgress = false;
              const next = nextTransitions.shift();
              if (next !== undefined) {
                setStatusText(next);
              }
            };
            statusDiv.innerHTML = text;
            statusDiv.style.opacity = "1.0";
          }
          statusDiv.style.opacity = "0.0";
          transitionInProgress = true;
        }
      }
    }
  }

  function removeLogoAnimation() {
    logoDiv.classList.remove('cg-preview-logo-animation');
  }

  function setPreviewDivVisibility(value: boolean) {
    if (value === true) {
      previewDiv.style.transition = "opacity 0.3s";
      previewDiv.style.pointerEvents = "auto";
      previewDiv.style.opacity = "1.0";
    } else {
      previewDiv.style.transition = "opacity 0.7s";
      previewDiv.style.pointerEvents = "none";
      previewDiv.style.opacity = "0.0";
    }
  }

  function setProgress(value: number) {
    progressBarDiv.style.width = `${(value * 100).toFixed(2)}%`;
  }

  function setProgressBarVisibility(value: boolean) {
    progressContainerDiv.style.opacity = value === true ? "1.0" : "0.0";
  }

  function setButton(innerHTML: string, onClick: () => void) {
    const btn = document.createElement('button');
    btn.id = "cg-preview-btn";
    btn.innerHTML = innerHTML;
    buttonDiv.innerHTML = "";
    buttonDiv.appendChild(btn);
    buttonDiv.style.opacity = "1.0";
    btn.onclick = onClick;
  }

  /* components */
  let _errorScreenTrigger: Function | undefined;
  class ErrorBoundary extends Component<{children?: any, errorScreenTrigger: Function}, {hasError: boolean}> {
    constructor(props: {children?: any, errorScreenTrigger: Function}) {
      super(props);
      this.errorScreenTrigger = props.errorScreenTrigger;
      this.state = { hasError: false };
    }

    get errorScreenTrigger() {
      return _errorScreenTrigger;
    }
    set errorScreenTrigger(trigger: Function | undefined) {
      _errorScreenTrigger = trigger;
    }
  
    static getDerivedStateFromError(error: unknown) {
      if (!!_errorScreenTrigger) {
        _errorScreenTrigger();
      }
      
      return { hasError: true };
    }
  
    componentDidCatch(error: unknown, errorInfo: unknown) {
      // You can also log the error to an error reporting service
      console.error("App received an error", error, errorInfo);
    }
  
    render() {
      if (this.state.hasError) {
        return <></>;
      }
      return this.props.children; 
    }
  }


  function Wrapper() {
    const [loadingFinished, setLoadingFinished] = useState<boolean>(false);
    const errorTriggered = useRef<boolean>(false);
    const matomoInjected = useRef<boolean>(false);
    const { finishInstallationTriggered } = useConnectionContext();

    const errorScreenTrigger = useCallback(() => {
      if (errorTriggered.current === false) {
        errorTriggered.current = true;
        setStatusText("Error :'(");
        setProgressBarVisibility(false);
        setPreviewDivVisibility(true);
        setButton('Reload the page', () => {
          window.location.href = "/";
        });
      }
    }, []);

    useEffect(() => {
      (async () => {
        try {
          setProgressBarVisibility(false);
          await Promise.all([preloadApp(), preloadRouter()]);
          setProgressBarVisibility(false);
          startTransition(() => {
            setLoadingFinished(true);
          });
        } catch (e) {
          errorScreenTrigger();
        }
      })();
    }, [errorScreenTrigger]);

    useEffect(() => {
      if (finishInstallationTriggered === true) {
        setProgressBarVisibility(false);
        setPreviewDivVisibility(true);
      }
    }, [finishInstallationTriggered]);

    useEffect(() => {
      if (
        loadingFinished === true &&
        !errorTriggered.current &&
        !finishInstallationTriggered
      ) {
        setStatusText("");
        setPreviewDivVisibility(false);
        setTimeout(() => {
          removeLogoAnimation();
        }, 750);
      }
    }, [finishInstallationTriggered, loadingFinished]);

    useEffect(() => {
      if (
        // CG's matomo only tracks the official instances; self-hosted
        // instances (identified by an injected instance config) skip it
        !(window as any).__CG_INSTANCE__ &&
        (config.DEPLOYMENT === "staging" || config.DEPLOYMENT === "prod") &&
        loadingFinished === true &&
        matomoInjected.current === false
      ) {
        matomoInjected.current = true;
        // "manually" set up matomo injection code
        const _paq: any[] = (window as any)._paq = (window as any)._paq || [];
        _paq.push(['disableCookies']);
        _paq.push(['trackPageView']);
        _paq.push(['enableLinkTracking']);
        (function() {
          const u=`https://analytics.${config.DEPLOYMENT}.app.cg/`;
          _paq.push(['setTrackerUrl', u+'matomo.php']);
          _paq.push(['setSiteId', `${config.DEPLOYMENT === "prod" ? "1" : "4"}`]);
          var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
          g.async=true; g.src=u+'matomo.js'; s.parentNode?.insertBefore(g,s);
        })();
      }
    }, [loadingFinished]);

    if (loadingFinished === true) {
      return (
        <ErrorBoundary errorScreenTrigger={errorScreenTrigger}>
          <Router>
            <GlobalDictionaryProvider>
              <App />
            </GlobalDictionaryProvider>
          </Router>
        </ErrorBoundary>
      );
    } else {
      return <></>;
    }
  }

  const root = createRoot(document.getElementById('root') as HTMLElement);

  if (config.DEPLOYMENT === 'dev') {
    // with some issues, it helps to disable strict mode for
    // the dev env temporarily -> // <StrictMode>
    root.render(
      <ConnectionProvider>
        <Wrapper />
      </ConnectionProvider>
    );

    // lazy import, only on dev
    import('./reportWebVitals').then(module => {
      module.default();
    });
  } else {
    root.render(
      <StrictMode>
        <ConnectionProvider>
          <Wrapper />
        </ConnectionProvider>
      </StrictMode>
    );
  }
}

// workaround for ES6 error
export default {};
