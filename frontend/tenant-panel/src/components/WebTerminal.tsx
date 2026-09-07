import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Play, Square } from 'lucide-react';
import { useTerminal, useDeploymentComponents } from '../hooks/use-container-console';

interface WebTerminalProps {
  deploymentId: string;
  defaultComponent?: string;
}

export default function WebTerminal({ deploymentId, defaultComponent }: WebTerminalProps) {
  const { components } = useDeploymentComponents(deploymentId);
  const [selectedComponent, setSelectedComponent] = useState(defaultComponent ?? '');
  const [shell, setShell] = useState('/bin/sh');

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeComponent = selectedComponent || components[0]?.name || '';

  const { connect, send, resize, disconnect, connected, error } = useTerminal(
    deploymentId,
    { component: activeComponent, shell, enabled: false },
  );

  // Kept in refs because the terminal effect runs exactly once; reading the
  // render-time values inside it would pin them to their first-render state.
  const connectedRef = useRef(false);
  const sendRef = useRef(send);

  const handleConnect = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.writeln('\x1b[33mConnecting...\x1b[0m');
    }
    disconnect();
    connect((data) => {
      xtermRef.current?.write(data);
    });
  }, [connect, disconnect]);

  const handleDisconnect = useCallback(() => {
    disconnect();
    xtermRef.current?.writeln('\r\n\x1b[31mDisconnected.\x1b[0m');
  }, [disconnect]);

  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => { sendRef.current = send; }, [send]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#364a82',
      },
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    term.onData((data) => send(data));

    // Paste.
    //
    // xterm.js DOES handle the browser's native paste on its own hidden
    // `xterm-helper-textarea`, so Ctrl+V (and Ctrl+Shift+V, and middle-click)
    // already reach the shell without any help. Binding them here as well sent
    // the clipboard TWICE — proven in a real browser on DEV:
    //
    //   $ echo UNIQ_MARKER_Aecho UNIQ_MARKER_A
    //
    // and no amount of de-duplicating inside this component could fix it,
    // because xterm's own insertion never passes through our code. So the
    // key handler deliberately does NOT touch V.
    //
    // What the terminal genuinely lacked was right-click paste, and a copy
    // shortcut. Those are the only two bound here.
    const paste = (): void => {
      navigator.clipboard?.readText()
        .then((text) => { if (text) sendRef.current(text); })
        .catch(() => undefined); // denied / insecure context / unfocused
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection();
        // Only swallow when there IS a selection — otherwise Ctrl+C must keep
        // reaching the shell, or a running command cannot be interrupted.
        if (sel) { navigator.clipboard?.writeText(sel).catch(() => undefined); return false; }
      }
      return true;
    });

    const host = terminalRef.current;

    // Ctrl+V and middle-click: handled through the browser's native `paste`
    // event, and ONLY there.
    //
    // Measured on DEV against the deployed build, because each attempt looked
    // right in isolation:
    //   • key handler + this listener together -> pasted TWICE. The key
    //     handler reads the clipboard asynchronously, so it lands outside any
    //     short de-duplication window and cannot be collapsed against this one.
    //   • neither of them -> pasted ZERO times. xterm does not paste on its
    //     own here, so something must forward it.
    // Exactly one synchronous path is therefore the only correct shape.
    const onPasteEvent = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text');
      if (text) { e.preventDefault(); sendRef.current(text); }
    };
    host.addEventListener('paste', onPasteEvent);

    // Right-click pastes, as most terminal emulators do — no native paste
    // event fires for it, so this reads the clipboard itself. The browser's
    // own context menu is suppressed so it does not cover the terminal.
    const onContextMenu = (e: MouseEvent): void => { e.preventDefault(); paste(); };
    host.addEventListener('contextmenu', onContextMenu);

    term.writeln('\x1b[90mPress Connect to start a terminal session.\x1b[0m');

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      // connectedRef, not `connected`: this effect runs once, so the captured
      // value would be `false` forever and the remote PTY would never learn
      // the new size — the shell would keep wrapping at the original width.
      if (connectedRef.current) resize(term.cols, term.rows);
    });
    observer.observe(terminalRef.current);

    // The first fit() above runs before the modal has finished laying out, so
    // it measures a container that is not yet its final height and picks too
    // many rows. The extra rows render below the visible area — the bottom of
    // the output, including the prompt, sits outside the box and cannot be
    // scrolled to, because xterm believes it is already at the bottom.
    // Re-fit once layout has settled.
    const raf = requestAnimationFrame(() => {
      fitAddon.fit();
      if (connectedRef.current) resize(term.cols, term.rows);
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('paste', onPasteEvent);
      term.dispose();
      disconnect();
    };
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="web-terminal">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <select
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1 text-gray-900 dark:text-gray-100"
          value={activeComponent}
          onChange={(e) => setSelectedComponent(e.target.value)}
          disabled={connected}
          data-testid="terminal-component-selector"
        >
          {components.map((c) => (
            <option key={c.name} value={c.name}>{c.name}</option>
          ))}
        </select>

        <select
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1 text-gray-900 dark:text-gray-100"
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          disabled={connected}
        >
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/ash">/bin/ash</option>
        </select>

        {connected ? (
          <button
            onClick={handleDisconnect}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors"
            data-testid="terminal-disconnect"
          >
            <Square size={12} />
            Disconnect
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!activeComponent}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50"
            data-testid="terminal-connect"
          >
            <Play size={12} />
            Connect
          </button>
        )}

        <div className="flex-1" />

        <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`}
          title={connected ? 'Connected' : 'Disconnected'} />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs">
          {error}
          <button onClick={handleConnect} className="ml-2 underline">Retry</button>
        </div>
      )}

      {/* Terminal */}
      {/*
        min-h-0 is load-bearing. A flex item defaults to min-height:auto, so
        this div refuses to shrink below its content: xterm's rows make it
        TALLER than the h-80 wrapper, whose overflow-hidden then clips the
        bottom. The clipped rows are the newest output — the prompt and the
        last command — and no amount of scrolling reveals them, because xterm
        is already scrolled to the bottom of a viewport that is simply taller
        than the box drawn around it. overflow-hidden here keeps a transient
        mid-resize overflow from pushing the layout.
      */}
      <div
        ref={terminalRef}
        className="flex-1 min-h-0 overflow-hidden bg-[#1a1b26]"
        data-testid="terminal-container"
      />
    </div>
  );
}
