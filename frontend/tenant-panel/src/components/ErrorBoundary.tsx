import { Component, type ReactNode, type ErrorInfo } from 'react';
import { isStaleChunkError, reloadForNewBuild } from '@/lib/stale-chunk';

interface Props {
  readonly children: ReactNode;
  /**
   * Render this instead of the full-screen crash page.
   *
   * Lets a self-contained widget fail on its own without replacing the entire
   * panel. The app-level boundary keeps the full-screen fallback; a header tile
   * that cannot format a number should simply disappear.
   */
  readonly fallback?: ReactNode;
  /** Identifies the failing area in the console when a `fallback` is used. */
  readonly label?: string;
  /** Reload for a new build (lib/stale-chunk); true when it did. Injectable for tests. */
  readonly onStaleChunk?: () => boolean;
}

interface State {
  readonly hasError: boolean;
  readonly error: Error | null;
  readonly reloading: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, reloading: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A page of the previous build after an upgrade rolled the panel: load the
    // same URL again rather than call it a crash. Only the app-level boundary
    // does; a scoped widget shows its fallback (Vite's preload hook in main.tsx
    // still loads the new build for a failed file, wherever it was imported).
    if (this.props.fallback === undefined && isStaleChunkError(error)) {
      this.setState({ reloading: (this.props.onStaleChunk ?? reloadForNewBuild)() });
      return;
    }
    console.error(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}] Uncaught error:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.hasError) {
      // A scoped boundary swallows its own area and leaves the rest of the app
      // usable. Without this, ANY render throw anywhere — including a header
      // tile formatting a null — blanked the whole panel, recoverable only by
      // reloading, which is exactly how this was reported.
      if (this.props.fallback !== undefined) return this.props.fallback;

      if (isStaleChunkError(this.state.error)) {
        return (
          <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900 p-6">
            <div className="max-w-lg w-full rounded-xl border border-blue-200 dark:border-blue-800 bg-white dark:bg-gray-800 p-6 shadow-lg" data-testid="stale-build-notice">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">The panel was updated</h2>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                {this.state.reloading
                  ? 'Loading the new version…'
                  : 'This tab still runs the previous version and could not load the new one. Reload the page to load it.'}
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Reload Page
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900 p-6">
          <div className="max-w-lg w-full rounded-xl border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">Something went wrong</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              The page crashed due to an unexpected error. Try refreshing the page.
            </p>
            <pre className="text-xs bg-gray-100 dark:bg-gray-900 rounded-lg p-3 overflow-x-auto text-red-700 dark:text-red-300 mb-4 max-h-40 overflow-y-auto">
              {this.state.error?.message}{'\n'}{this.state.error?.stack?.split('\n').slice(1, 5).join('\n')}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
