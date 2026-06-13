import { Component } from "react";

// App-wide error boundary. Catches render/runtime errors in its subtree —
// including failed React.lazy() chunk loads — and shows a recoverable fallback
// instead of a blank white screen.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Surface the error for debugging. Swap for a real reporter (e.g. Sentry)
    // when one is wired up.
    console.error("ErrorBoundary caught an error:", error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-6">
        <div className="font-mono text-xs uppercase tracking-widest text-[#EB0029] mb-3">
          Something went wrong
        </div>
        <h2 className="font-space text-2xl font-bold text-white mb-2">
          This view hit an unexpected error
        </h2>
        <p className="text-sm text-[#9A9AA6] max-w-md mb-6">
          The rest of Klar is still working. Try again, or reload the page if
          the problem persists.
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={this.handleRetry}
            className="bg-[#EB0029] hover:bg-[#FF2740] text-white px-5 py-2 rounded-full font-medium text-sm transition-all"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="font-mono text-xs uppercase tracking-widest text-[#9A9AA6] hover:text-white transition-colors"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
