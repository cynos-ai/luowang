export const ENVIRONMENT_STAGES = {
  source: '读取固定源码',
  executor: '准备测试工具',
  parse: '解析启动配置',
  build: '构建应用镜像',
  initialize: '准备文件和初始数据',
  start: '启动应用',
  health: '检查应用健康',
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
  }>;
  failure: { stage: EnvironmentStage; message: string } | null;
  cleanupConfirmed: boolean;
  startedAt: string;
  finishedAt: string | null;
  stale?: boolean;
};
