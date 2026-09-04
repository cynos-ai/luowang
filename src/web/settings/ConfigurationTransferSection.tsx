import { SectionCard } from '../components/FormControls';

export function ConfigurationTransferSection({
  busy,
  onExport,
  onImport,
}: {
  busy: string | null;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  return (
    <SectionCard
      id="configuration-file-title"
      eyebrow="CONFIGURATION FILE"
      title="配置文件"
      description="导出或导入版本化 YAML 普通配置。API Key、Token、账号和密码不会写入文件；导入也不会覆盖 Secret Store。"
      actions={
        <>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy !== null}
            onClick={onExport}
          >
            {busy === 'config-export' ? '导出中…' : '导出 YAML'}
          </button>
          <label className={`button file-button ${busy !== null ? 'button-disabled' : ''}`}>
            {busy === 'config-import' ? '导入中…' : '导入 YAML'}
            <input
              className="visually-hidden"
              type="file"
              accept=".yml,.yaml,application/yaml,text/yaml,text/x-yaml"
              disabled={busy !== null}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) onImport(file);
              }}
            />
          </label>
        </>
      }
    >
      <p className="notice notice-neutral">
        YAML 是备份与迁移载体，不是运行时事实源。导入会原子替换普通配置并将旧连接结果标记为待检查。
      </p>
    </SectionCard>
  );
}
