import { Component, type ReactNode } from "react";

interface Props {
  /** Close handler for the wrapped sheet — lets the user dismiss a
   *  crashed sheet without reloading the whole app. */
  onClose: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render crash inside a single case / work-item sheet so one
 * bad record can't unmount the entire dashboard (the classic React
 * white-screen). React error boundaries have to be class components —
 * there's no hook equivalent — so this is the one class in the tree.
 *
 * Scoped per-sheet (keyed by sheet id at the call site): a crash shows
 * a dismissible panel in place of that sheet, the rest of the app keeps
 * running, and closing it pops the sheet off the stack.
 */
export class SheetErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Surface it in the console so the component stack is inspectable;
    // no record fields are logged (could carry case data).
    // eslint-disable-next-line no-console
    console.error("Sheet render crashed:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alertdialog"
          aria-label="Sheet error"
          style={{
            position: "fixed",
            left: 0, right: 0, bottom: 0,
            zIndex: 1800,
            borderTop: "2px solid #F87171",
            boxShadow: "0 -8px 24px rgba(0,0,0,0.25)",
          }}
          className="solid-panel rounded-none px-6 py-5 flex items-center justify-between gap-4"
        >
          <div className="min-w-0">
            <p className="font-semibold text-rose-600 dark:text-rose-300">
              Dieser Fall konnte nicht angezeigt werden.
            </p>
            <p className="text-sm opacity-70 mt-0.5">
              Der Rest der App läuft weiter. Schließe diesen Tab und
              versuche es erneut.
            </p>
          </div>
          <button
            type="button"
            onClick={this.props.onClose}
            className="pill surface-1 surface-1-hover text-sm shrink-0"
          >
            Schließen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
