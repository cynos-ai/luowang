import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export interface ProjectRecord {
  projectId: string;
  displayName: string;
  githubRepositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  status: 'active' | 'paused';
  configRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface VerifiedRepositoryIdentity {
  githubRepositoryId: string;
  owner: string;
  name: string;
}

export interface ProjectStore {
  createVerified(input: {
    displayName: string;
    repository: VerifiedRepositoryIdentity;
  }): ProjectRecord;
  get(projectId: string): ProjectRecord | null;
  list(): ProjectRecord[];
}

export class ProjectStoreError extends Error {
  constructor(
    readonly code: 'PROJECT_INVALID' | 'PROJECT_ALREADY_EXISTS',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

export function createProjectStore(
  database: Database.Database,
  options: { now?: () => string; id?: () => string } = {},
): ProjectStore {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  return {
    createVerified(input) {
      const displayName = input.displayName.trim();
      const githubRepositoryId = input.repository.githubRepositoryId.trim();
      const repositoryOwner = input.repository.owner.trim();
      const repositoryName = input.repository.name.trim();
      if (
        displayName.length < 1 ||
        displayName.length > 120 ||
        !/^[1-9][0-9]*$/.test(githubRepositoryId) ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repositoryOwner) ||
        !/^[A-Za-z0-9_.-]{1,100}$/.test(repositoryName) ||
        repositoryName === '.' ||
        repositoryName === '..'
      ) {
        throw new ProjectStoreError('PROJECT_INVALID', '项目名称或已验证仓库身份无效');
      }
      const projectId = id();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          projectId,
        )
      ) {
        throw new ProjectStoreError('PROJECT_INVALID', '项目 ID 无效');
      }
      const timestamp = now();
      try {
        database
          .prepare(
            `INSERT INTO projects
               (project_id, display_name, github_repository_id, repository_owner,
                repository_name, status, config_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'paused', 1, ?, ?)`,
          )
          .run(
            projectId,
            displayName,
            githubRepositoryId,
            repositoryOwner,
            repositoryName,
            timestamp,
            timestamp,
          );
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) {
          const duplicate = database
            .prepare(
              `SELECT 1 FROM projects
               WHERE github_repository_id = ?
                  OR (repository_owner = ? COLLATE NOCASE
                      AND repository_name = ? COLLATE NOCASE)`,
            )
            .get(githubRepositoryId, repositoryOwner, repositoryName);
          if (duplicate) {
            throw new ProjectStoreError('PROJECT_ALREADY_EXISTS', '该 GitHub 仓库已接入');
          }
        }
        throw error;
      }
      return requireProject(database, projectId);
    },
    get(projectId) {
      const row = database.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
        ProjectRow | undefined;
      return row ? toProject(row) : null;
    },
    list() {
      return (
        database
          .prepare('SELECT * FROM projects ORDER BY created_at, project_id')
          .all() as ProjectRow[]
      ).map(toProject);
    },
  };
}

interface ProjectRow {
  project_id: string;
  display_name: string;
  github_repository_id: string;
  repository_owner: string;
  repository_name: string;
  status: 'active' | 'paused';
  config_revision: number;
  created_at: string;
  updated_at: string;
}

function requireProject(database: Database.Database, projectId: string): ProjectRecord {
  const row = database.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
    ProjectRow | undefined;
  if (!row) throw new Error('项目写入后无法读取');
  return toProject(row);
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id,
    displayName: row.display_name,
    githubRepositoryId: row.github_repository_id,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    status: row.status,
    configRevision: row.config_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
