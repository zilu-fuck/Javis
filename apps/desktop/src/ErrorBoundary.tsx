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
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
            background: "#1a1a2e",
            color: "#e0e0e0",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#a0a0a0", marginBottom: "1rem", maxWidth: "480px", textAlign: "center" }}>
            An unexpected error occurred. Please restart the application.
          </p>
          <pre
            style={{
              background: "#0d0d1a",
              padding: "1rem",
              borderRadius: "6px",
              fontSize: "0.75rem",
              maxWidth: "600px",
              overflow: "auto",
              color: "#f87171",
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1.5rem",
              borderRadius: "6px",
              border: "1px solid #444",
              background: "#2a2a3e",
              color: "#e0e0e0",
              cursor: "pointer",
            }}
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
