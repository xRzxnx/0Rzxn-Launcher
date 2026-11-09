// @ts-check
'use strict';

// launcher.db : historique du launcher (tâches, parties), dans le dossier des réglages.
// Mode hybride : les instances, mondes, mods et comptes restent des fichiers. Perdre cette base ne fait rien
// perdre d'important ; sans elle, le launcher marche normalement et les écritures sont ignorées.
//
// Une seule connexion, dans le processus principal (le verrou d'instance unique garantit un seul processus).
// Migrations numérotées par PRAGMA user_version, chacune dans une transaction, avec une copie de la base avant.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { journal } = require('../core/journal');

/** Migrations : MIGRATIONS[n - 1] fait passer la base à la version n. Ne jamais modifier une migration publiée. */
const MIGRATIONS = [
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     label TEXT,
     instance_id TEXT,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     ended_at INTEGER,
     error TEXT,
     params TEXT
   );
   CREATE INDEX tasks_ended ON tasks(ended_at);
   CREATE TABLE game_sessions (
     id INTEGER PRIMARY KEY,
     instance_id TEXT NOT NULL,
     version TEXT,
     loader TEXT,
     started_at INTEGER NOT NULL,
     ready_at INTEGER,
     ended_at INTEGER,
     outcome TEXT,
     exit_code INTEGER,
     prepare_ms INTEGER
   );
   CREATE INDEX sessions_instance ON game_sessions(instance_id, started_at);`,
];

const BACKUPS_KEPT = 2;
const TASKS_KEPT = 1000;
const TASKS_MAX_AGE = 90 * 24 * 3600 * 1000;

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/** La base et ses fichiers WAL renommés de côté (base illisible) ; le launcher en recrée une vide. */
function setAside(file, now) {
  const target = `${file}.abimee-${stamp(new Date(now()))}`;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.renameSync(file + suffix, target + suffix);
    } catch {
      // fichier absent
    }
  }
  return target;
}

/** Garde les copies d'avant migration les plus récentes. */
function pruneBackups(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.avant-v`;
  const copies = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  for (const name of copies.slice(BACKUPS_KEPT)) fs.rmSync(path.join(dir, name), { force: true });
}

/** @param {DatabaseSync} db @param {string} file @param {string[]} migrations */
function migrate(db, file, migrations) {
  const current = Number(/** @type {any} */ (db.prepare('PRAGMA user_version').get()).user_version);
  if (current === migrations.length) return current;
  if (current > migrations.length) throw Object.assign(new Error(`launcher.db version ${current} is newer than this launcher (${migrations.length})`), { newer: true });
  if (current > 0) {
    // Copie cohérente même en mode WAL, avant de toucher au schéma.
    const copy = `${file}.avant-v${migrations.length}`;
    fs.rmSync(copy, { force: true });
    db.exec(`VACUUM INTO ${sqlText(copy)}`);
    pruneBackups(file);
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[version - 1]);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return migrations.length;
}

/** @param {string} file @param {string[]} migrations */
function connect(file, migrations) {
  const db = new DatabaseSync(file, { timeout: 2000, enableForeignKeyConstraints: true });
  try {
    // Seule une base illisible dès la première lecture est considérée comme abîmée (pas une migration en échec).
    let check;
    try {
      check = /** @type {any} */ (db.prepare('PRAGMA quick_check').get());
    } catch (error) {
      throw Object.assign(error, { corrupt: true });
    }
    if (check?.quick_check !== 'ok') throw Object.assign(new Error(`launcher.db quick_check: ${check?.quick_check}`), { corrupt: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    const version = migrate(db, file, migrations);
    return { db, version };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Ouvre (ou crée) la base. Ne lève jamais d'erreur : en cas de problème, renvoie une base « absente »
 * dont les écritures sont ignorées (`available` vaut false).
 * @param {{ file: string, migrations?: string[], now?: () => number }} options
 */
function openDatabase({ file, migrations = MIGRATIONS, now = Date.now }) {
  /** @type {DatabaseSync | null} */
  let db = null;
  let version = 0;
  /** @type {null | 'newer' | 'error'} */
  let problem = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ({ db, version } = connect(file, migrations));
  } catch (error) {
    if (error.newer) {
      problem = 'newer';
      journal.warn('launcher.db left untouched:', error.message);
    } else if (error.corrupt) {
      // Base illisible : mise de côté, puis une base neuve.
      const aside = setAside(file, now);
      journal.warn(`launcher.db unreadable, moved to ${path.basename(aside)}:`, error);
      try {
        ({ db, version } = connect(file, migrations));
      } catch (again) {
        problem = 'error';
        journal.error('launcher.db unavailable:', again);
      }
    } else {
      problem = 'error';
      journal.error('launcher.db unavailable:', error);
    }
  }

  /** Exécute une écriture ; une erreur est notée, jamais renvoyée. @param {string} what @param {(db: DatabaseSync) => any} fn */
  const safely = (what, fn) => {
    if (!db) return null;
    try {
      return fn(db);
    } catch (error) {
      journal.warn(`launcher.db ${what} failed:`, error);
      return null;
    }
  };

  // Ménage au démarrage : l'historique des tâches reste court.
  safely('purge', (d) => {
    d.prepare('DELETE FROM tasks WHERE ended_at IS NOT NULL AND ended_at < ?').run(now() - TASKS_MAX_AGE);
    d.prepare('DELETE FROM tasks WHERE id NOT IN (SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?)').run(TASKS_KEPT);
  });

  return {
    available: Boolean(db),
    version,
    /** null, 'newer' (base d'une version plus récente du launcher) ou 'error'. */
    problem,
    file,

    /** Tâche terminée (ou mise à jour d'une tâche connue). */
    recordTask(task) {
      return safely('recordTask', (d) =>
        d
          .prepare(
            `INSERT OR REPLACE INTO tasks (id, kind, label, instance_id, state, created_at, started_at, ended_at, error, params)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            String(task.id),
            String(task.kind),
            task.label ?? null,
            task.instanceId ?? null,
            String(task.state),
            task.createdAt ?? now(),
            task.startedAt ?? null,
            task.endedAt ?? null,
            task.error ?? null,
            task.params == null ? null : JSON.stringify(task.params),
          ),
      );
    },
    /** Dernières tâches, de la plus récente à la plus ancienne. */
    recentTasks(limit = 50) {
      return (
        safely('recentTasks', (d) =>
          d
            .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
            .all(limit)
            .map((row) => ({ ...row, params: row.params ? JSON.parse(String(row.params)) : null })),
        ) ?? []
      );
    },

    /** Début d'une préparation ou d'une partie : renvoie l'identifiant de la session (ou null). */
    startSession({ instanceId, version: gameVersion = null, loader = null, startedAt = now() }) {
      return safely('startSession', (d) => {
        const { lastInsertRowid } = d
          .prepare('INSERT INTO game_sessions (instance_id, version, loader, started_at) VALUES (?, ?, ?, ?)')
          .run(String(instanceId), gameVersion, loader, startedAt);
        return Number(lastInsertRowid);
      });
    },
    /** Le jeu a démarré : temps de préparation. */
    sessionReady(id, readyAt = now()) {
      if (id == null) return null;
      return safely('sessionReady', (d) => d.prepare('UPDATE game_sessions SET ready_at = ?, prepare_ms = ? - started_at WHERE id = ?').run(readyAt, readyAt, id));
    },
    /** Fin : prepared, exited, crashed, failed ou cancelled. */
    endSession(id, { outcome, exitCode = null, endedAt = now() }) {
      if (id == null) return null;
      return safely('endSession', (d) => d.prepare('UPDATE game_sessions SET ended_at = ?, outcome = ?, exit_code = ? WHERE id = ?').run(endedAt, outcome, exitCode, id));
    },
    /** Dernières sessions d'une instance, de la plus récente à la plus ancienne. */
    recentSessions(instanceId, limit = 50) {
      return safely('recentSessions', (d) => d.prepare('SELECT * FROM game_sessions WHERE instance_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(String(instanceId), limit)) ?? [];
    },

    close() {
      if (!db) return;
      safely('close', (d) => d.close());
      db = null;
    },
  };
}

module.exports = { openDatabase, MIGRATIONS };
