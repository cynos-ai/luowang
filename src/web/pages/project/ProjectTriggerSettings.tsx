import { useState } from 'react';
import { Field, HelpLabel, NumberInput, SelectBox, Switch, Button } from '../../components/ui';
import type { ProjectConfiguration } from '../../project-types';

function Interval({
  label,
  seconds,
  disabled,
  onChange,
  minimum = 1,
}: {
  label: string;
  seconds: number;
  disabled: boolean;
  onChange: (value: number) => void;
  minimum?: number;
}) {
  const [unit, setUnit] = useState(
    seconds > 0 && seconds % 86400 === 0
      ? 86400
      : seconds > 0 && seconds % 3600 === 0
        ? 3600
        : seconds > 0 && seconds % 60 === 0
          ? 60
          : 1,
  );
  return (
    <fieldset className="field interval-control">
      <legend>{label}</legend>
      <div className="interval-inputs">
        <NumberInput
          ariaLabel={label}
          min={Math.max(1, Math.ceil(minimum / unit))}
          max={604800 / unit}
          step={1}
          value={Math.max(1, seconds / unit)}
          disabled={disabled}
          onChange={(value) => onChange(value * unit)}
        />
        <SelectBox
          ariaLabel={`${label}单位`}
          value={String(unit)}
          disabled={disabled}
          options={[
            { value: '1', label: '秒' },
            { value: '60', label: '分钟' },
            { value: '3600', label: '小时' },
            { value: '86400', label: '天' },
          ]}
          onChange={(value) => {
            const next = Number(value);
            const amount = Math.max(1, Math.round(seconds / unit));
            setUnit(next);
            onChange(Math.max(minimum, Math.min(604800, amount * next)));
          }}
        />
      </div>
    </fieldset>
  );
}

export function ProjectTriggerSettings({
  configuration,
  disabled,
  onChange,
  onSave,
}: {
  configuration: ProjectConfiguration;
  disabled: boolean;
  onChange: (value: ProjectConfiguration) => void;
  onSave: (patch: Partial<ProjectConfiguration>) => void;
}) {
  const config = configuration;
  const enabled = Boolean(config.cron.trim() || config.scheduleIntervalSeconds);
  const [lastInterval, setLastInterval] = useState(config.scheduleIntervalSeconds || 3600);
  const update = (patch: Partial<ProjectConfiguration>) => onChange({ ...config, ...patch });
  return (
    <form
      className="settings-stack project-trigger-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          triggerOnCommit: config.triggerOnCommit,
          pollIntervalSeconds: config.pollIntervalSeconds,
          scheduleIntervalSeconds: config.scheduleIntervalSeconds ?? 0,
          cron: config.cron,
        });
      }}
    >
      <section
        className="trigger-rule"
        data-enabled={config.triggerOnCommit}
        aria-labelledby="commit-trigger-title"
      >
        <header className="trigger-rule-heading">
          <h3 id="commit-trigger-title">新提交时测试</h3>
          <Switch
            ariaLabel="启用提交检查"
            disabled={disabled}
            checked={config.triggerOnCommit}
            onChange={(checked) =>
              update({
                triggerOnCommit: checked,
                pollIntervalSeconds: Math.max(300, config.pollIntervalSeconds),
              })
            }
          />
        </header>
        <Interval
          label="检查间隔"
          seconds={config.pollIntervalSeconds || 300}
          minimum={300}
          disabled={disabled || !config.triggerOnCommit}
          onChange={(pollIntervalSeconds) => update({ pollIntervalSeconds })}
        />
      </section>
      <section
        className="trigger-rule"
        data-enabled={enabled}
        aria-labelledby="schedule-trigger-title"
      >
        <header className="trigger-rule-heading">
          <h3 id="schedule-trigger-title">
            <HelpLabel
              label="定时触发测试"
              help="到点检查待测提交，有待测任务才安排测试。已完成的版本不会重复测试。"
            />
          </h3>
          <Switch
            ariaLabel="启用定时检查"
            disabled={disabled}
            checked={enabled}
            onChange={(checked) =>
              update({ scheduleIntervalSeconds: checked ? lastInterval : 0, cron: '' })
            }
          />
        </header>
        <Interval
          label="每隔"
          seconds={config.scheduleIntervalSeconds || lastInterval}
          disabled={disabled || !enabled || Boolean(config.cron.trim())}
          onChange={(scheduleIntervalSeconds) => {
            setLastInterval(scheduleIntervalSeconds);
            update({ scheduleIntervalSeconds, cron: '' });
          }}
        />
        <details className="settings-details" open={Boolean(config.cron)}>
          <summary>Cron（高级，UTC）</summary>
          <Field label="Cron">
            <input
              value={config.cron}
              disabled={disabled || !enabled}
              placeholder="0 8 * * *"
              onChange={(event) =>
                update({
                  cron: event.target.value,
                  scheduleIntervalSeconds: event.target.value.trim() ? 0 : lastInterval,
                })
              }
            />
          </Field>
        </details>
      </section>
      <div className="form-actions">
        <Button type="submit" disabled={disabled}>
          保存触发规则
        </Button>
      </div>
    </form>
  );
}
