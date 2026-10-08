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
      description="YAML 配置备份（不含凭据）"
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
    ></SectionCard>
  );
}
