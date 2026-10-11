export const ENVIRONMENT_STAGES = {
  source: '读取固定源码',
  executor: '准备测试工具',
  parse: '解析启动配置',
  build: '准备或复用应用镜像',
  create: '创建独立容器',
  files: '注入本次文件',
  dependencies: '启动依赖服务',
  initialize: '执行迁移与种子脚本',
  start: '启动应用',
  health: '检查应用健康',
  data: '核验必要测试数据',
  account: '核验测试账号登录与身份',
  cleanup: '清理验证环境',
} as const;
export type EnvironmentStage = keyof typeof ENVIRONMENT_STAGES;
export type EnvironmentValidationTask = {
  id: string;
  projectId: string;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  targetCommit: string | null;
  fingerprint: string;
  resourceId: string;
  steps: Array<{
    stage: EnvironmentStage;
    status: 'running' | 'passed' | 'failed';
    message?: string;
    startedAt?: string;
    finishedAt?: string | null;
    durationMs?: number | null;
  }>;
  failure: { stage: EnvironmentStage; message: string } | null;
  cleanupConfirmed: boolean;
  startedAt: string;
  finishedAt: string | null;
  stale?: boolean;
};
