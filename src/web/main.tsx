import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';

import App from './App';
import AppRouter from './app/AppRouter';
import { AppDialogProvider } from './components/AppDialogProvider';
import { AppMessageProvider } from './components/AppMessageProvider';
import './styles.css';
import './tokens.css';
import './components.css';
import './pages.css';

const root = createRoot(document.getElementById('root')!);
const render = (content: ReactNode) =>
  root.render(
    <AppMessageProvider>
      <AppDialogProvider>{content}</AppDialogProvider>
    </AppMessageProvider>,
  );
async function start() {
  try {
    const response = await fetch('/api/mode');
    if (response.status === 404) {
      render(<App />);
      return;
    }
    if (!response.ok) throw new Error('无法识别服务模式');
    const value = (await response.json()) as { mode?: string };
    if (value.mode !== 'multi-project') throw new Error('服务模式不受支持');
    render(<AppRouter />);
  } catch {
    render(
      <main className="app-shell">
        <section className="panel">
          <h1>暂时无法连接罗网</h1>
          <p>刷新页面后重试。</p>
          <button className="button" type="button" onClick={() => window.location.reload()}>
            重新连接
          </button>
        </section>
      </main>,
    );
  }
}
void start();
