import type { Logger } from 'pino';

import type { ConfigurationStore } from '../configuration.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import type { ArchiveResult } from '../runs/archiver.js';
import type { AutomationService, RetentionCleanupResult } from './service.js';
import type { GitPollResult, GitPoller } from './poller.js';
import type { AutomationStateStore } from './state.js';

export interface SchedulerTickResult {
  polled: GitPollResult | null;
  archived: ArchiveResult[];
  indexed: boolean;
  cleaned: RetentionCleanupResult | null;
  cronTriggered: boolean;
}

export interface AutomationSchedulerStatus {
  running: boolean;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastArchiveAt: string | null;
  nextArchiveAt: string | null;
  lastIndexerAt: string | null;
  nextIndexerAt: string | null;
  lastCleanupAt: string | null;
  nextCleanupAt: string | null;
  lastCronKey: string | null;
  lastError: string | null;
}

export interface AutomationScheduler {
  start(): void;
  stop(): void;
  tick(at?: Date): Promise<SchedulerTickResult>;
  status(): AutomationSchedulerStatus;
}

export interface AutomationSchedulerOptions {
  configuration: ConfigurationStore;
  poller: GitPoller;
  automation: AutomationService;
  indexer?: RepositoryIndexer;
  state: AutomationStateStore;
  now?: () => Date;
  logger?: Logger;
}

const LAST_POLL_AT = 'scheduler.last-poll-at';
const LAST_ARCHIVE_AT = 'scheduler.last-archive-at';
const LAST_INDEXER_AT = 'scheduler.last-indexer-at';
const LAST_CLEANUP_AT = 'scheduler.last-cleanup-at';
const LAST_CRON_KEY = 'scheduler.last-cron-key';
const LAST_ERROR = 'scheduler.last-error';
const DEFAULT_ARCHIVE_SECONDS = 10;
const DEFAULT_INDEXER_SECONDS = 300;
const DEFAULT_CLEANUP_SECONDS = 300;

export function createAutomationScheduler(
  options: AutomationSchedulerOptions,
): AutomationScheduler {
  return new DefaultAutomationScheduler(options);
}

export const createScheduler = createAutomationScheduler;

class DefaultAutomationScheduler implements AutomationScheduler {
  private readonly now: () => Date;
  private lastPollAt: Date;
  private lastArchiveAt: Date;
  private lastIndexerAt: Date;
  private lastCleanupAt: Date;
  private lastCronKey: string | null;
  private lastError: string | null;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    const current = this.now();
    this.lastPollAt = readDate(options.state.get(LAST_POLL_AT)) ?? current;
    this.lastArchiveAt = readDate(options.state.get(LAST_ARCHIVE_AT)) ?? current;
    this.lastIndexerAt = readDate(options.state.get(LAST_INDEXER_AT)) ?? current;
    this.lastCleanupAt = readDate(options.state.get(LAST_CLEANUP_AT)) ?? current;
    this.lastCronKey = options.state.get(LAST_CRON_KEY);
    this.lastError = options.state.get(LAST_ERROR);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(at: Date = this.now()): Promise<SchedulerTickResult> {
    if (this.ticking) {
      return { polled: null, archived: [], indexed: false, cleaned: null, cronTriggered: false };
    }
    this.ticking = true;
    const result: SchedulerTickResult = {
      polled: null,
      archived: [],
      indexed: false,
      cleaned: null,
      cronTriggered: false,
    };
    try {
      const repository = this.options.configuration.getRepository();
      const pollSeconds = repository.pollIntervalSeconds;
      if (pollSeconds > 0 && due(at, this.lastPollAt, pollSeconds * 1_000)) {
        this.lastPollAt = at;
        this.persistDate(LAST_POLL_AT, at);
        result.polled =
          (await this.runTask('Git Poll', () => this.options.poller.poll('git'))) ?? null;
      }

      const cronKey = cronKeyFor(at);
      if (repository.cron.trim() !== '' && cronKey !== this.lastCronKey) {
        try {
          if (matchesCron(repository.cron, at)) {
            this.lastCronKey = cronKey;
            this.options.state.set(LAST_CRON_KEY, cronKey);
            result.cronTriggered = true;
            const cronResult = await this.runTask('Cron Poll', () =>
              this.options.poller.poll('schedule'),
            );
            if (!result.polled && cronResult) result.polled = cronResult;
          }
        } catch (error) {
          this.recordError(errorMessage(error, 'Cron 表达式无效'));
        }
      }

      if (due(at, this.lastArchiveAt, DEFAULT_ARCHIVE_SECONDS * 1_000)) {
        this.lastArchiveAt = at;
        this.persistDate(LAST_ARCHIVE_AT, at);
        result.archived =
          (await this.runTask('Archiver', () => this.options.automation.scanArchives())) ?? [];
      }

      if (due(at, this.lastCleanupAt, DEFAULT_CLEANUP_SECONDS * 1_000)) {
        this.lastCleanupAt = at;
        this.persistDate(LAST_CLEANUP_AT, at);
        result.cleaned =
          (await this.runTask('Retention cleanup', () =>
            this.options.automation.cleanupRetention(),
          )) ?? null;
      }

      if (this.options.indexer && due(at, this.lastIndexerAt, DEFAULT_INDEXER_SECONDS * 1_000)) {
        this.lastIndexerAt = at;
        this.persistDate(LAST_INDEXER_AT, at);
        await this.runTask('Repository Indexer', async () => {
          const sync = await this.options.indexer!.sync();
          result.indexed = sync.status === 'synced';
          return sync;
        });
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  status(): AutomationSchedulerStatus {
    const repository = this.options.configuration.getRepository();
    return {
      running: this.timer !== undefined,
      lastPollAt: this.lastPollAt.toISOString(),
      nextPollAt:
        repository.pollIntervalSeconds > 0
          ? new Date(
              this.lastPollAt.getTime() + repository.pollIntervalSeconds * 1_000,
            ).toISOString()
          : null,
      lastArchiveAt: this.lastArchiveAt.toISOString(),
      nextArchiveAt: new Date(
        this.lastArchiveAt.getTime() + DEFAULT_ARCHIVE_SECONDS * 1_000,
      ).toISOString(),
      lastIndexerAt: this.lastIndexerAt.toISOString(),
      nextIndexerAt: new Date(
        this.lastIndexerAt.getTime() + DEFAULT_INDEXER_SECONDS * 1_000,
      ).toISOString(),
      lastCleanupAt: this.lastCleanupAt.toISOString(),
      nextCleanupAt: new Date(
        this.lastCleanupAt.getTime() + DEFAULT_CLEANUP_SECONDS * 1_000,
      ).toISOString(),
      lastCronKey: this.lastCronKey,
      lastError: this.lastError,
    };
  }

  private async runTask<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await task();
      this.lastError = null;
      this.options.state.delete(LAST_ERROR);
      return result;
    } catch (error) {
      const message = errorMessage(error, `${label} 执行失败`);
      this.recordError(message);
      return undefined;
    }
  }

  private persistDate(key: string, value: Date): void {
    this.options.state.set(key, value.toISOString());
  }

  private recordError(error: unknown): void {
    const message = typeof error === 'string' ? error : errorMessage(error, '后台任务失败');
    this.lastError = message;
    this.options.state.set(LAST_ERROR, message);
    this.options.logger?.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      message,
    );
  }
}

function due(at: Date, previous: Date, intervalMs: number): boolean {
  return at.getTime() >= previous.getTime() + intervalMs;
}

function readDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cronKeyFor(date: Date): string {
  return [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
  ]
    .map((value) => String(value).padStart(2, '0'))
    .join('-');
}

export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron 必须包含 5 个字段');
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  const parsed = fields.map((field, index) =>
    parseCronField(field, ranges[index]![0], ranges[index]![1]),
  );
  const dayOfMonthMatches = parsed[2]!.has(values[2]!);
  const dayOfWeekMatches = parsed[4]!.has(values[4]!) || (values[4] === 0 && parsed[4]!.has(7));
  const dayOfMonthRestricted = fields[2] !== '*';
  const dayOfWeekRestricted = fields[4] !== '*';
  const dayMatches =
    dayOfMonthRestricted && dayOfWeekRestricted
      ? dayOfMonthMatches || dayOfWeekMatches
      : dayOfMonthMatches && dayOfWeekMatches;
  return (
    parsed[0]!.has(values[0]!) &&
    parsed[1]!.has(values[1]!) &&
    parsed[3]!.has(values[3]!) &&
    dayMatches
  );
}

function parseCronField(field: string, minimum: number, maximum: number): Set<number> {
  if (field.trim() === '') throw new Error('Cron 字段不能为空');
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [base, stepText] = part.split('/', 2);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) throw new Error('Cron 步长无效');
    let start = minimum;
    let end = maximum;
    if (base !== '*') {
      if (base?.includes('-')) {
        const [startText, endText] = base.split('-', 2);
        start = readCronNumber(startText, minimum, maximum);
        end = readCronNumber(endText, minimum, maximum);
        if (start > end) throw new Error('Cron 范围无效');
      } else {
        start = readCronNumber(base, minimum, maximum);
        end = stepText === undefined ? start : maximum;
      }
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function readCronNumber(value: string | undefined, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error('Cron 数字超出范围');
  }
  return number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}
