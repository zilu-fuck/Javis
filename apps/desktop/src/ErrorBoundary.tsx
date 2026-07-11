import { Component } from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[Javis ErrorBoundary]", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="javis-error-boundary">
          <h1 className="javis-error-boundary-title">
            Something went wrong
          </h1>
          <p className="javis-error-boundary-desc">
            An unexpected error occurred. Please restart the application.
          </p>
          <pre className="javis-error-boundary-pre">
            {this.state.error.message}
          </pre>
          <button
            className="javis-error-boundary-button"
            onClick={() => this.setState({ error: null })}
            type="button"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
