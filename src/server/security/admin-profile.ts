import type Database from 'better-sqlite3';

export interface AdminProfile {
  displayName: string;
}

export interface AdminProfileStore {
  get(): AdminProfile | null;
  updateDisplayName(input: unknown): AdminProfile;
}

export function createAdminProfileStore(database: Database.Database): AdminProfileStore {
  return {
    get() {
      const row = database
        .prepare('SELECT display_name FROM admin_credentials WHERE id = 1')
        .get() as { display_name: string } | undefined;
      return row ? { displayName: row.display_name } : null;
    },
    updateDisplayName(input) {
      if (typeof input !== 'string') throw new TypeError('显示名称无效');
      const displayName = input.trim();
      if (
        displayName.length < 1 ||
        displayName.length > 64 ||
        [...displayName].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
      ) {
        throw new TypeError('显示名称必须是 1 到 64 个可见字符');
      }
      const updated = database
        .prepare('UPDATE admin_credentials SET display_name = ?, updated_at = ? WHERE id = 1')
        .run(displayName, new Date().toISOString());
      if (updated.changes !== 1) throw new Error('管理员尚未初始化');
      return { displayName };
    },
  };
}
