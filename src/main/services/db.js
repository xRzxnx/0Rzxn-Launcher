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
  // 2 (phase 6) : menu du jeu atteint, pic de mémoire ; empreintes des jars ; historique des optimisations.
  `ALTER TABLE game_sessions ADD COLUMN menu_ms INTEGER;
   ALTER TABLE game_sessions ADD COLUMN peak_memory INTEGER;
   CREATE TABLE file_hashes (
     path TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     mtime_ms REAL NOT NULL,
     sha1 TEXT NOT NULL,
     meta TEXT,
     used_at INTEGER NOT NULL
   );
   CREATE TABLE optimizations (
     id INTEGER PRIMARY KEY,
     instance_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     summary TEXT,
     snapshot TEXT NOT NULL,
     added TEXT
   );
   CREATE INDEX optimizations_instance ON optimizations(instance_id, created_at);`,
];

const BACKUPS_KEPT = 2;
// Clés réservées dans la colonne params des tâches.
const PROGRESS_KEY = '_progress';
const HIDDEN_KEY = '_hidden';
const TASKS_KEPT = 1000;
const TASKS_MAX_AGE = 90 * 24 * 3600 * 1000;
const HASHES_KEPT = 20000;

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
    d.prepare('DELETE FROM tasks WHERE id NOT IN (SELECT id FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?)').run(TASKS_KEPT);
    if (version >= 2) d.prepare('DELETE FROM file_hashes WHERE path NOT IN (SELECT path FROM file_hashes ORDER BY used_at DESC LIMIT ?)').run(HASHES_KEPT);
  });
  const parse = (text) => {
    try {
      return text == null ? null : JSON.parse(String(text));
    } catch {
      return null;
    }
  };

  return {
    available: Boolean(db),
    version,
    /** null, 'newer' (base d'une version plus récente du launcher) ou 'error'. */
    problem,
    file,

    /**
     * Tâche terminée (ou mise à jour d'une tâche connue). La progression finale (fichiers, octets) et le drapeau
     * « travail de fond » voyagent dans la colonne params, sous des clés à part : le format de la base ne change pas.
     */
    recordTask(task) {
      const extra = {};
      if (task.progress && Object.keys(task.progress).length) extra[PROGRESS_KEY] = task.progress;
      if (task.hidden) extra[HIDDEN_KEY] = true;
      const params = Object.keys(extra).length ? { ...(task.params ?? {}), ...extra } : task.params;
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
            params == null ? null : JSON.stringify(params),
          ),
      );
    },
    /** Dernières tâches, de la plus récente à la plus ancienne ({ progress, hidden } sortis de params). */
    recentTasks(limit = 50) {
      return (
        safely('recentTasks', (d) =>
          d
            // Deux tâches créées dans la même milliseconde : la dernière enregistrée d'abord (INSERT OR REPLACE donne
            // un nouveau rowid à chaque écriture). Sans ça, l'ordre dépend de SQLite (vu sur les Mac rapides de la CI).
            .prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?')
            .all(limit)
            .map((row) => {
              const { [PROGRESS_KEY]: progress = null, [HIDDEN_KEY]: hidden = false, ...params } = row.params ? JSON.parse(String(row.params)) : {};
              return { ...row, params: row.params && Object.keys(params).length ? params : null, progress, hidden };
            }),
        ) ?? []
      );
    },
    /** Efface l'historique des tâches finies (page Activité). */
    clearTasks() {
      return safely('clearTasks', (d) => d.prepare("DELETE FROM tasks WHERE state IN ('done', 'failed', 'cancelled')").run());
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
    /** Menu du jeu atteint (ligne repérée dans les logs) : temps depuis le démarrage de Java. */
    sessionMenu(id, menuAt = now()) {
      if (id == null || version < 2) return null;
      return safely('sessionMenu', (d) => d.prepare('UPDATE game_sessions SET menu_ms = ? - ready_at WHERE id = ? AND ready_at IS NOT NULL AND menu_ms IS NULL').run(menuAt, id));
    },
    /** Pic de mémoire du jeu (octets), gardé s'il dépasse le précédent. */
    sessionPeak(id, bytes) {
      if (id == null || version < 2 || !(bytes > 0)) return null;
      return safely('sessionPeak', (d) => d.prepare('UPDATE game_sessions SET peak_memory = MAX(COALESCE(peak_memory, 0), ?) WHERE id = ?').run(Math.round(bytes), id));
    },
    /** Dernière partie lancée d'une instance : temps de préparation, jusqu'au menu, pic de mémoire. */
    lastLaunch(instanceId) {
      if (version < 2) return null;
      const row = safely('lastLaunch', (d) =>
        d.prepare('SELECT started_at, prepare_ms, menu_ms, peak_memory FROM game_sessions WHERE instance_id = ? AND ready_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1').get(String(instanceId)),
      );
      if (!row) return null;
      return { startedAt: Number(row.started_at), prepareMs: row.prepare_ms == null ? null : Number(row.prepare_ms), menuMs: row.menu_ms == null ? null : Number(row.menu_ms), peakMemory: row.peak_memory == null ? null : Number(row.peak_memory) };
    },

    /** Empreinte connue d'un fichier, si sa taille et sa date n'ont pas changé : { sha1, meta } ou null. */
    fileHash(file, size, mtimeMs) {
      if (version < 2) return null;
      const row = safely('fileHash', (d) => d.prepare('SELECT size, mtime_ms, sha1, meta FROM file_hashes WHERE path = ?').get(String(file)));
      if (!row || Number(row.size) !== size || Number(row.mtime_ms) !== mtimeMs) return null;
      return { sha1: String(row.sha1), meta: parse(row.meta) };
    },
    /** Note l'empreinte d'un fichier lu (ou met à jour ses métadonnées). */
    saveFileHash(file, { size, mtimeMs, sha1, meta = null }) {
      if (version < 2) return null;
      return safely('saveFileHash', (d) =>
        d
          .prepare('INSERT OR REPLACE INTO file_hashes (path, size, mtime_ms, sha1, meta, used_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(String(file), size, mtimeMs, String(sha1), meta == null ? null : JSON.stringify(meta), now()),
      );
    },

    /** Optimisation notée avant d'être appliquée ; renvoie son identifiant. */
    addOptimization({ instanceId, kind, summary = null, snapshot, added = null, createdAt = now() }) {
      if (version < 2) return null;
      return safely('addOptimization', (d) => {
        const { lastInsertRowid } = d
          .prepare('INSERT INTO optimizations (instance_id, kind, created_at, summary, snapshot, added) VALUES (?, ?, ?, ?, ?, ?)')
          .run(String(instanceId), String(kind), createdAt, summary == null ? null : JSON.stringify(summary), String(snapshot), added == null ? null : JSON.stringify(added));
        return Number(lastInsertRowid);
      });
    },
    /** Résumé d'une optimisation mis à jour (changements rapprochés regroupés). */
    setOptimizationSummary(id, summary) {
      if (id == null || version < 2) return null;
      return safely('setOptimizationSummary', (d) => d.prepare('UPDATE optimizations SET summary = ? WHERE id = ?').run(JSON.stringify(summary), id));
    },
    /** Fichiers ajoutés par une optimisation (connus après coup, par exemple les mods d'un pack). */
    setOptimizationAdded(id, added) {
      if (id == null || version < 2) return null;
      return safely('setOptimizationAdded', (d) => d.prepare('UPDATE optimizations SET added = ? WHERE id = ?').run(JSON.stringify(added ?? []), id));
    },
    /** Optimisations d'une instance, de la plus récente à la plus ancienne. */
    optimizations(instanceId) {
      if (version < 2) return [];
      return (
        safely('optimizations', (d) => d.prepare('SELECT * FROM optimizations WHERE instance_id = ? ORDER BY created_at DESC, id DESC').all(String(instanceId))) ?? []
      ).map((row) => ({
        id: Number(row.id),
        instanceId: String(row.instance_id),
        kind: String(row.kind),
        createdAt: Number(row.created_at),
        summary: parse(row.summary),
        snapshot: String(row.snapshot),
        added: parse(row.added) ?? [],
      }));
    },
    removeOptimizations(ids) {
      if (version < 2 || !ids.length) return null;
      return safely('removeOptimizations', (d) => {
        const remove = d.prepare('DELETE FROM optimizations WHERE id = ?');
        for (const id of ids) remove.run(id);
      });
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
