import { useEffect, lazy, Suspense } from 'react';
import { useTerminalSessions } from '@/stores/terminal-sessions';
import { BackgroundTerminalsDock } from './BackgroundTerminalsDock';

// LAZY, NOT STATIC — and not for bundle size.
//
// This host is mounted in App.tsx, so it renders on every page. A static import
// of NodeTerminalModal compiles that whole module into the ENTRY chunk, which
// every page view downloads. NodeTerminalStepUpDialog contains a password input
// (`step-up-password`), so the operator's password manager saw a password field
// in the bytes of every page and popped its autofill prompt on every
// navigation — while they were already signed in.
//
// Conditional rendering does NOT help: the markup ships regardless of whether
// it is ever in the DOM. Same lesson as ChangePasswordModal (2026-08-04).
// Guarded by scripts/ci-no-password-fields-in-entry-chunk.sh.
//
// These are named exports, hence the `.then(m => ({ default: m.X }))` shape.
const NodeTerminalModal = lazy(() =>
  import('./NodeTerminalModal').then((m) => ({ default: m.NodeTerminalModal })));
const NodeTerminalStepUpDialog = lazy(() =>
  import('./NodeTerminalModal').then((m) => ({ default: m.NodeTerminalStepUpDialog })));
const NodeTerminalOpenErrorBanner = lazy(() =>
  import('./NodeTerminalModal').then((m) => ({ default: m.NodeTerminalOpenErrorBanner })));
const NodeTerminalOpeningOverlay = lazy(() =>
  import('./NodeTerminalModal').then((m) => ({ default: m.NodeTerminalOpeningOverlay })));

/**
 * App-level mount point for the node-terminal feature. Renders:
 *   - The active modal when a session is foregrounded
 *   - The step-up dialog when openFresh is waiting on credentials
 *   - The error banner when openFresh fails for a non-step-up reason
 *   - The background dock (only visible when there are minimized sessions)
 *
 * Lives in App.tsx so its children survive page navigation. The xterm
 * Terminal + WebSocket for each session live in the store's vanilla
 * ref map — outside the React tree entirely — so route changes never
 * disrupt the running shell.
 */
export function NodeTerminalHost() {
  const activeId = useTerminalSessions((s) => s.activeId);
  const sessions = useTerminalSessions((s) => s.sessions);
  const pendingStepUp = useTerminalSessions((s) => s.pendingStepUp);
  const stepUpError = useTerminalSessions((s) => s.stepUpError);
  const openError = useTerminalSessions((s) => s.openError);
  const openingFor = useTerminalSessions((s) => s.openingFor);
  const verifyStepUpPassword = useTerminalSessions((s) => s.verifyStepUpPassword);
  const verifyStepUpPasskey = useTerminalSessions((s) => s.verifyStepUpPasskey);
  const openFresh = useTerminalSessions((s) => s.openFresh);
  const restoreFromStorage = useTerminalSessions((s) => s.restoreFromStorage);

  // On app mount, ask the store to re-attach any sessions that were
  // open when the user navigated away or reloaded. The store reads
  // sessionStorage, POSTs /ws-token for each persisted entry, and
  // reconstructs a fresh xterm + WebSocket for each — within the
  // server's 60s grace period the privileged Pod is still alive on
  // the host, so the shell state survives. Idempotent — fires once.
  // restoreFromStorage is stable across renders (zustand action), so
  // an empty deps array is correct here even though ESLint can't see
  // through the zustand-returned identity stability.
  useEffect(() => {
    void restoreFromStorage();
  }, [restoreFromStorage]);

  const active = activeId ? sessions.find((s) => s.id === activeId) : undefined;
  // Show the provisioning overlay only when: an open-flow is in
  // progress, the modal isn't already open for it, AND we're not
  // currently in the step-up phase (which has its own dialog).
  const showOpeningOverlay = openingFor !== null && !active && !pendingStepUp;

  // Hold a reference to the pending node-name for the error banner's
  // Retry action (the openFresh state machine clears pendingStepUp on
  // success, but we want to remember which node the operator targeted).
  const errorRetryNodeName = pendingStepUp?.nodeName
    ?? sessions[sessions.length - 1]?.nodeName
    ?? null;

  return (
    // fallback={null}: these are overlays over the page the operator is already
    // looking at. A spinner here would flash over working UI for the few ms the
    // chunk takes to arrive from the same origin.
    <Suspense fallback={null}>
      {active && <NodeTerminalModal sessionId={active.id} nodeName={active.nodeName} />}
      {showOpeningOverlay && openingFor && <NodeTerminalOpeningOverlay nodeName={openingFor} />}
      {pendingStepUp && (
        <NodeTerminalStepUpDialog
          nodeName={pendingStepUp.nodeName}
          methods={pendingStepUp.methods}
          error={stepUpError}
          onVerifyPassword={verifyStepUpPassword}
          onVerifyPasskey={verifyStepUpPasskey}
          onCancel={() => useTerminalSessions.setState({ pendingStepUp: null, stepUpError: null })}
        />
      )}
      {openError && (
        <NodeTerminalOpenErrorBanner
          message={openError}
          onRetry={() => {
            if (errorRetryNodeName) void openFresh(errorRetryNodeName);
            else useTerminalSessions.setState({ openError: null });
          }}
          onDismiss={() => useTerminalSessions.setState({ openError: null })}
        />
      )}
      <BackgroundTerminalsDock />
    </Suspense>
  );
}
