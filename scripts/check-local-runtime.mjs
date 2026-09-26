import { createRequire } from 'node:module';

const nodeVersion = process.versions.node;
if (Number(nodeVersion.split('.')[0]) !== 24) {
  console.error(`本项目需要 Node.js 24；当前是 ${nodeVersion}。请切换版本后重新运行 npm ci。`);
  process.exitCode = 1;
} else {
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const database = new Database(':memory:');
    database.close();
    console.log(`本地运行环境可用：Node.js ${nodeVersion}，better-sqlite3 已加载。`);
  } catch {
    console.error(
      'better-sqlite3 无法在当前 Node.js 下加载。请重新运行 npm ci；若本机缺少原生编译工具，可使用仓库的 quality 容器运行检查。',
    );
    process.exitCode = 1;
  }
}
