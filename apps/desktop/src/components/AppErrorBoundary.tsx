import { Component, type ErrorInfo, type ReactNode } from "react";
import "./AppErrorBoundary.css";

interface State { message: string | null }

/** Keep a render or lazy-chunk failure visible and recoverable instead of a blank window. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { message: null };
  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("界面渲染失败", error, info.componentStack);
  }
  render() {
    if (this.state.message === null) return this.props.children;
    return <div className="app-error-boundary" role="alert">
      <p className="app-error-boundary-title">界面暂时无法显示</p>
      <p className="app-error-boundary-detail">重新加载后可继续使用；已保存的素材与项目不受影响。</p>
      <button type="button" onClick={() => location.reload()}>重新加载</button>
      <details><summary>诊断信息</summary><code>{this.state.message}</code></details>
    </div>;
  }
}
