import { createRoot } from 'react-dom/client';

import App from './App';
import ProjectApp from './projects/ProjectApp';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
async function start() {
  try {
    const response = await fetch('/api/mode');
    if (response.status === 404) {
      root.render(<App />);
      return;
    }
    if (!response.ok) throw new Error('无法识别服务模式');
    const value = (await response.json()) as { mode?: string };
    if (value.mode !== 'multi-project') throw new Error('服务模式不受支持');
    root.render(<ProjectApp />);
  } catch {
    root.render(
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
