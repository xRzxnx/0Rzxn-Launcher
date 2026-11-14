//! launcher.db : historique du launcher (tâches, parties), dans le dossier des réglages (services/db.js).
//! Mode hybride : instances, mondes, mods et comptes restent des fichiers. Perdre cette base ne fait rien perdre
//! d'important ; sans elle, le launcher marche normalement et les écritures sont ignorées.
//! Migrations numérotées par PRAGMA user_version, chacune dans une transaction, avec une copie de la base avant.

use crate::journal;
use commun::DernierLancement;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// MIGRATIONS[n - 1] fait passer la base à la version n. Ne jamais modifier une migration publiée.
pub const MIGRATIONS: [&str; 2] = [
    "CREATE TABLE tasks (
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
     CREATE INDEX sessions_instance ON game_sessions(instance_id, started_at);",
    // 2 (phase 6) : menu du jeu atteint, pic de mémoire ; empreintes des jars ; historique des optimisations.
    "ALTER TABLE game_sessions ADD COLUMN menu_ms INTEGER;
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
     CREATE INDEX optimizations_instance ON optimizations(instance_id, created_at);",
];

const COPIES_GARDEES: usize = 2;
// Clés réservées dans la colonne params des tâches.
const CLE_PROGRESSION: &str = "_progress";
const CLE_CACHEE: &str = "_hidden";
const TACHES_GARDEES: i64 = 1000;
const AGE_MAX_TACHES: i64 = 90 * 24 * 3600 * 1000;
const EMPREINTES_GARDEES: i64 = 20000;

pub fn maintenant() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probleme {
    /// Base d'une version plus récente du launcher : laissée telle quelle.
    PlusRecente,
    Erreur,
}

#[derive(Debug)]
enum Echec {
    Abimee(String),
    PlusRecente(String),
    Autre(String),
}

fn sql_texte(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// La base et ses fichiers WAL renommés de côté (base illisible) ; le launcher en recrée une vide.
fn mettre_de_cote(fichier: &Path, quand: i64) -> PathBuf {
    let date = chrono::DateTime::from_timestamp_millis(quand).unwrap_or_default().with_timezone(&chrono::Local);
    let cible = PathBuf::from(format!("{}.abimee-{}", fichier.display(), date.format("%Y-%m-%d_%H-%M-%S")));
    for suffixe in ["", "-wal", "-shm"] {
        let _ = std::fs::rename(format!("{}{suffixe}", fichier.display()), format!("{}{suffixe}", cible.display()));
    }
    cible
}

/// Garde les copies d'avant migration les plus récentes.
fn elaguer_copies(fichier: &Path) {
    let (Some(dossier), Some(nom)) = (fichier.parent(), fichier.file_name()) else { return };
    let prefixe = format!("{}.avant-v", nom.to_string_lossy());
    let mut copies: Vec<(u32, PathBuf)> = std::fs::read_dir(dossier)
        .map(|it| {
            it.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().strip_prefix(&prefixe)?.parse().ok()?;
                    Some((n, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    copies.sort_by_key(|c| std::cmp::Reverse(c.0));
    for (_, chemin) in copies.into_iter().skip(COPIES_GARDEES) {
        let _ = std::fs::remove_file(chemin);
    }
}

fn migrer(db: &Connection, fichier: &Path, migrations: &[&str]) -> Result<u32, Echec> {
    let autre = |e: rusqlite::Error| Echec::Autre(e.to_string());
    let actuelle: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(autre)?;
    let cible = migrations.len() as u32;
    if actuelle == cible {
        return Ok(actuelle);
    }
    if actuelle > cible {
        return Err(Echec::PlusRecente(format!("launcher.db version {actuelle} is newer than this launcher ({cible})")));
    }
    if actuelle > 0 {
        // Copie cohérente même en mode WAL, avant de toucher au schéma.
        let copie = format!("{}.avant-v{cible}", fichier.display());
        let _ = std::fs::remove_file(&copie);
        db.execute_batch(&format!("VACUUM INTO {}", sql_texte(&copie))).map_err(autre)?;
        elaguer_copies(fichier);
    }
    for version in actuelle + 1..=cible {
        db.execute_batch("BEGIN IMMEDIATE").map_err(autre)?;
        let r =
            db.execute_batch(migrations[version as usize - 1]).and_then(|_| db.execute_batch(&format!("PRAGMA user_version = {version}")));
        match r {
            Ok(()) => db.execute_batch("COMMIT").map_err(autre)?,
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK");
                return Err(autre(e));
            }
        }
    }
    Ok(cible)
}

fn connecter(fichier: &Path, migrations: &[&str]) -> Result<(Connection, u32), Echec> {
    let db = Connection::open(fichier).map_err(|e| Echec::Autre(e.to_string()))?;
    let _ = db.busy_timeout(std::time::Duration::from_millis(2000));
    // Seule une base illisible dès la première lecture est considérée comme abîmée (pas une migration en échec).
    let verif: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| Echec::Abimee(e.to_string()))?;
    if verif != "ok" {
        return Err(Echec::Abimee(format!("launcher.db quick_check: {verif}")));
    }
    let autre = |e: rusqlite::Error| Echec::Autre(e.to_string());
    db.execute_batch("PRAGMA foreign_keys = ON").map_err(autre)?;
    let _: String = db.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).map_err(autre)?;
    db.execute_batch("PRAGMA synchronous = NORMAL").map_err(autre)?;
    let version = migrer(&db, fichier, migrations)?;
    Ok((db, version))
}

/// Tâche à enregistrer (ou mise à jour d'une tâche connue).
#[derive(Debug, Clone, Default)]
pub struct Tache {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    pub instance_id: Option<String>,
    pub state: String,
    pub created_at: Option<i64>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub error: Option<String>,
    pub params: Option<Map<String, Value>>,
    /// Progression finale (fichiers, octets), rangée dans params sous une clé à part.
    pub progress: Option<Map<String, Value>>,
    /// Travail de fond (pas montré dans l'Activité).
    pub hidden: bool,
}

/// Optimisation notée avant d'être appliquée.
#[derive(Debug, Clone, PartialEq)]
pub struct Optimisation {
    pub id: i64,
    pub instance_id: String,
    pub kind: String,
    pub created_at: i64,
    pub summary: Option<Value>,
    pub snapshot: String,
    pub added: Value,
}

pub struct Base {
    db: Mutex<Option<Connection>>,
    version: u32,
    probleme: Option<Probleme>,
    fichier: PathBuf,
    horloge: fn() -> i64,
}

fn json(texte: Option<String>) -> Option<Value> {
    serde_json::from_str(&texte?).ok()
}

fn valeur(r: &rusqlite::Row, i: usize) -> Value {
    use rusqlite::types::ValueRef;
    match r.get_ref(i) {
        Ok(ValueRef::Integer(n)) => n.into(),
        Ok(ValueRef::Real(f)) => f.into(),
        Ok(ValueRef::Text(t)) => String::from_utf8_lossy(t).into_owned().into(),
        _ => Value::Null,
    }
}

/// Ligne en objet JSON { colonne: valeur }, comme les lignes de node:sqlite.
fn ligne(r: &rusqlite::Row) -> rusqlite::Result<Map<String, Value>> {
    let noms: Vec<String> = r.as_ref().column_names().map(|s| s.to_string()).collect();
    Ok(noms.into_iter().enumerate().map(|(i, n)| (n, valeur(r, i))).collect())
}

impl Base {
    /// Ouvre (ou crée) la base. Ne renvoie jamais d'erreur : en cas de problème, une base « absente »
    /// dont les écritures sont ignorées.
    pub fn ouvrir(fichier: &Path) -> Self {
        Self::ouvrir_avec(fichier, &MIGRATIONS, maintenant)
    }

    pub fn ouvrir_avec(fichier: &Path, migrations: &[&str], horloge: fn() -> i64) -> Self {
        let mut probleme = None;
        let essai = fichier
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .map_err(|e| Echec::Autre(e.to_string()))
            .and_then(|_| connecter(fichier, migrations));
        let connexion = match essai {
            Ok(c) => Some(c),
            Err(Echec::PlusRecente(m)) => {
                probleme = Some(Probleme::PlusRecente);
                journal::warn(&format!("launcher.db left untouched: {m}"));
                None
            }
            Err(Echec::Abimee(m)) => {
                // Base illisible : mise de côté, puis une base neuve.
                let de_cote = mettre_de_cote(fichier, horloge());
                journal::warn(&format!("launcher.db unreadable, moved to {}: {m}", de_cote.display()));
                match connecter(fichier, migrations) {
                    Ok(c) => Some(c),
                    Err(e) => {
                        probleme = Some(Probleme::Erreur);
                        journal::error(&format!("launcher.db unavailable: {e:?}"));
                        None
                    }
                }
            }
            Err(Echec::Autre(m)) => {
                probleme = Some(Probleme::Erreur);
                journal::error(&format!("launcher.db unavailable: {m}"));
                None
            }
        };
        let (db, version) = match connexion {
            Some((db, v)) => (Some(db), v),
            None => (None, 0),
        };
        let base = Self { db: Mutex::new(db), version, probleme, fichier: fichier.to_path_buf(), horloge };
        // Ménage au démarrage : l'historique des tâches reste court.
        let avant = horloge() - AGE_MAX_TACHES;
        base.prudemment("purge", |d| {
            d.execute("DELETE FROM tasks WHERE ended_at IS NOT NULL AND ended_at < ?", [avant])?;
            d.execute(
                "DELETE FROM tasks WHERE id NOT IN (SELECT id FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?)",
                [TACHES_GARDEES],
            )?;
            if version >= 2 {
                d.execute(
                    "DELETE FROM file_hashes WHERE path NOT IN (SELECT path FROM file_hashes ORDER BY used_at DESC LIMIT ?)",
                    [EMPREINTES_GARDEES],
                )?;
            }
            Ok(())
        });
        base
    }

    pub fn disponible(&self) -> bool {
        self.db.lock().map(|d| d.is_some()).unwrap_or(false)
    }
    pub fn version(&self) -> u32 {
        self.version
    }
    pub fn probleme(&self) -> Option<Probleme> {
        self.probleme
    }
    pub fn fichier(&self) -> &Path {
        &self.fichier
    }

    /// Exécute une requête ; une erreur est notée au journal, jamais renvoyée.
    fn prudemment<T>(&self, quoi: &str, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
        let garde = self.db.lock().ok()?;
        let d = garde.as_ref()?;
        f(d).inspect_err(|e| journal::warn(&format!("launcher.db {quoi} failed: {e}"))).ok()
    }

    fn v2(&self) -> bool {
        self.version >= 2
    }

    pub fn enregistrer_tache(&self, t: &Tache) -> Option<()> {
        let mut params = t.params.clone();
        let mut extra = Map::new();
        if let Some(p) = t.progress.as_ref().filter(|p| !p.is_empty()) {
            extra.insert(CLE_PROGRESSION.into(), Value::Object(p.clone()));
        }
        if t.hidden {
            extra.insert(CLE_CACHEE.into(), true.into());
        }
        if !extra.is_empty() {
            let mut p = params.unwrap_or_default();
            p.extend(extra);
            params = Some(p);
        }
        let params = params.map(|p| Value::Object(p).to_string());
        let cree = t.created_at.unwrap_or_else(self.horloge);
        self.prudemment("recordTask", |d| {
            d.execute(
                "INSERT OR REPLACE INTO tasks (id, kind, label, instance_id, state, created_at, started_at, ended_at, error, params)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![t.id, t.kind, t.label, t.instance_id, t.state, cree, t.started_at, t.ended_at, t.error, params],
            )
            .map(|_| ())
        })
    }

    /// Dernières tâches, de la plus récente à la plus ancienne ({ progress, hidden } sortis de params).
    pub fn taches_recentes(&self, limite: i64) -> Vec<Map<String, Value>> {
        self.prudemment("recentTasks", |d| {
            // Deux tâches créées dans la même milliseconde : la dernière enregistrée d'abord (nouveau rowid à chaque écriture).
            let mut st = d.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?")?;
            let lignes = st.query_map([limite], ligne)?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(lignes
                .into_iter()
                .map(|mut l| {
                    let mut params =
                        l.get("params").and_then(Value::as_str).and_then(|s| serde_json::from_str::<Map<String, Value>>(s).ok());
                    let progress = params.as_mut().and_then(|p| p.remove(CLE_PROGRESSION)).unwrap_or(Value::Null);
                    let hidden = params.as_mut().and_then(|p| p.remove(CLE_CACHEE)).and_then(|v| v.as_bool()).unwrap_or(false);
                    l.insert("params".into(), params.filter(|p| !p.is_empty()).map(Value::Object).unwrap_or(Value::Null));
                    l.insert("progress".into(), progress);
                    l.insert("hidden".into(), hidden.into());
                    l
                })
                .collect())
        })
        .unwrap_or_default()
    }

    /// Efface l'historique des tâches finies (page Activité).
    pub fn effacer_taches(&self) -> Option<usize> {
        self.prudemment("clearTasks", |d| d.execute("DELETE FROM tasks WHERE state IN ('done', 'failed', 'cancelled')", []))
    }

    /// Début d'une préparation ou d'une partie : identifiant de la session.
    pub fn debut_session(&self, instance_id: &str, version: Option<&str>, loader: Option<&str>, debut: Option<i64>) -> Option<i64> {
        let debut = debut.unwrap_or_else(self.horloge);
        self.prudemment("startSession", |d| {
            d.execute(
                "INSERT INTO game_sessions (instance_id, version, loader, started_at) VALUES (?, ?, ?, ?)",
                params![instance_id, version, loader, debut],
            )?;
            Ok(d.last_insert_rowid())
        })
    }

    /// Le jeu a démarré : temps de préparation.
    pub fn session_prete(&self, id: Option<i64>, quand: Option<i64>) -> Option<usize> {
        let (id, quand) = (id?, quand.unwrap_or_else(self.horloge));
        self.prudemment("sessionReady", |d| {
            d.execute("UPDATE game_sessions SET ready_at = ?, prepare_ms = ? - started_at WHERE id = ?", params![quand, quand, id])
        })
    }

    /// Fin : prepared, exited, crashed, failed ou cancelled.
    pub fn fin_session(&self, id: Option<i64>, issue: &str, code: Option<i64>, quand: Option<i64>) -> Option<usize> {
        let (id, quand) = (id?, quand.unwrap_or_else(self.horloge));
        self.prudemment("endSession", |d| {
            d.execute("UPDATE game_sessions SET ended_at = ?, outcome = ?, exit_code = ? WHERE id = ?", params![quand, issue, code, id])
        })
    }

    /// Menu du jeu atteint : temps depuis le démarrage de Java (noté une seule fois).
    pub fn session_menu(&self, id: Option<i64>, quand: Option<i64>) -> Option<usize> {
        let id = id.filter(|_| self.v2())?;
        let quand = quand.unwrap_or_else(self.horloge);
        self.prudemment("sessionMenu", |d| {
            d.execute(
                "UPDATE game_sessions SET menu_ms = ? - ready_at WHERE id = ? AND ready_at IS NOT NULL AND menu_ms IS NULL",
                params![quand, id],
            )
        })
    }

    /// Pic de mémoire du jeu (octets), gardé s'il dépasse le précédent.
    pub fn session_pic(&self, id: Option<i64>, octets: f64) -> Option<usize> {
        let id = id.filter(|_| self.v2() && octets > 0.0)?;
        self.prudemment("sessionPeak", |d| {
            d.execute(
                "UPDATE game_sessions SET peak_memory = MAX(COALESCE(peak_memory, 0), ?) WHERE id = ?",
                params![octets.round() as i64, id],
            )
        })
    }

    /// Dernière partie lancée d'une instance : temps de préparation, jusqu'au menu, pic de mémoire.
    pub fn dernier_lancement(&self, instance_id: &str) -> Option<DernierLancement> {
        if !self.v2() {
            return None;
        }
        self.prudemment("lastLaunch", |d| {
            d.query_row(
                "SELECT started_at, prepare_ms, menu_ms, peak_memory FROM game_sessions
                 WHERE instance_id = ? AND ready_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1",
                [instance_id],
                |r| Ok(DernierLancement { started_at: r.get(0)?, prepare_ms: r.get(1)?, menu_ms: r.get(2)?, peak_memory: r.get(3)? }),
            )
            .optional()
        })
        .flatten()
    }

    /// Empreinte connue d'un fichier, si sa taille et sa date n'ont pas changé : (sha1, meta).
    pub fn empreinte(&self, chemin: &str, taille: i64, mtime_ms: f64) -> Option<(String, Option<Value>)> {
        if !self.v2() {
            return None;
        }
        let r = self
            .prudemment("fileHash", |d| {
                d.query_row("SELECT size, mtime_ms, sha1, meta FROM file_hashes WHERE path = ?", [chemin], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?))
                })
                .optional()
            })
            .flatten()?;
        (r.0 == taille && r.1 == mtime_ms).then(|| (r.2, json(r.3)))
    }

    /// Note l'empreinte d'un fichier lu (ou met à jour ses métadonnées).
    pub fn noter_empreinte(&self, chemin: &str, taille: i64, mtime_ms: f64, sha1: &str, meta: Option<&Value>) -> Option<usize> {
        if !self.v2() {
            return None;
        }
        let meta = meta.map(Value::to_string);
        let quand = (self.horloge)();
        self.prudemment("saveFileHash", |d| {
            d.execute(
                "INSERT OR REPLACE INTO file_hashes (path, size, mtime_ms, sha1, meta, used_at) VALUES (?, ?, ?, ?, ?, ?)",
                params![chemin, taille, mtime_ms, sha1, meta, quand],
            )
        })
    }

    /// Optimisation notée avant d'être appliquée ; renvoie son identifiant.
    pub fn ajouter_optimisation(
        &self,
        instance_id: &str,
        kind: &str,
        resume: Option<&Value>,
        snapshot: &str,
        ajoutes: Option<&Value>,
        quand: Option<i64>,
    ) -> Option<i64> {
        if !self.v2() {
            return None;
        }
        let quand = quand.unwrap_or_else(self.horloge);
        let (resume, ajoutes) = (resume.map(Value::to_string), ajoutes.map(Value::to_string));
        self.prudemment("addOptimization", |d| {
            d.execute(
                "INSERT INTO optimizations (instance_id, kind, created_at, summary, snapshot, added) VALUES (?, ?, ?, ?, ?, ?)",
                params![instance_id, kind, quand, resume, snapshot, ajoutes],
            )?;
            Ok(d.last_insert_rowid())
        })
    }

    /// Résumé mis à jour (changements rapprochés regroupés).
    pub fn changer_resume_optimisation(&self, id: i64, resume: &Value) -> Option<usize> {
        if !self.v2() {
            return None;
        }
        self.prudemment("setOptimizationSummary", |d| {
            d.execute("UPDATE optimizations SET summary = ? WHERE id = ?", params![resume.to_string(), id])
        })
    }

    /// Fichiers ajoutés par une optimisation (connus après coup).
    pub fn changer_ajouts_optimisation(&self, id: i64, ajoutes: &Value) -> Option<usize> {
        if !self.v2() {
            return None;
        }
        self.prudemment("setOptimizationAdded", |d| {
            d.execute("UPDATE optimizations SET added = ? WHERE id = ?", params![ajoutes.to_string(), id])
        })
    }

    /// Optimisations d'une instance, de la plus récente à la plus ancienne.
    pub fn optimisations(&self, instance_id: &str) -> Vec<Optimisation> {
        if !self.v2() {
            return vec![];
        }
        self.prudemment("optimizations", |d| {
            let mut st = d.prepare(
                "SELECT id, instance_id, kind, created_at, summary, snapshot, added FROM optimizations
                 WHERE instance_id = ? ORDER BY created_at DESC, id DESC",
            )?;
            st.query_map([instance_id], |r| {
                Ok(Optimisation {
                    id: r.get(0)?,
                    instance_id: r.get(1)?,
                    kind: r.get(2)?,
                    created_at: r.get(3)?,
                    summary: json(r.get(4)?),
                    snapshot: r.get(5)?,
                    added: json(r.get(6)?).unwrap_or_else(|| Value::Array(vec![])),
                })
            })?
            .collect()
        })
        .unwrap_or_default()
    }

    pub fn retirer_optimisations(&self, ids: &[i64]) -> Option<()> {
        if !self.v2() || ids.is_empty() {
            return None;
        }
        self.prudemment("removeOptimizations", |d| {
            let mut st = d.prepare("DELETE FROM optimizations WHERE id = ?")?;
            for id in ids {
                st.execute([id])?;
            }
            Ok(())
        })
    }

    /// Dernières sessions d'une instance, de la plus récente à la plus ancienne.
    pub fn sessions_recentes(&self, instance_id: &str, limite: i64) -> Vec<Map<String, Value>> {
        self.prudemment("recentSessions", |d| {
            let mut st = d.prepare("SELECT * FROM game_sessions WHERE instance_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")?;
            st.query_map(params![instance_id, limite], ligne)?.collect()
        })
        .unwrap_or_default()
    }

    /// Ferme la base (une fermeture propre retire les fichiers -wal et -shm).
    pub fn fermer(&self) {
        if let Ok(mut d) = self.db.lock()
            && let Some(c) = d.take()
            && let Err((_, e)) = c.close()
        {
            journal::warn(&format!("launcher.db close failed: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use serde_json::json;

    const N: u32 = MIGRATIONS.len() as u32;

    fn fichier(d: &Dossier) -> PathBuf {
        d.0.join("launcher.db")
    }
    fn lire<T>(f: &Path, sql: &str, lecture: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>) -> Vec<T> {
        let c = Connection::open_with_flags(f, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut st = c.prepare(sql).unwrap();
        st.query_map([], lecture).unwrap().map(Result::unwrap).collect()
    }
    fn version(f: &Path) -> u32 {
        lire(f, "PRAGMA user_version", |r| r.get(0))[0]
    }
    fn tables(f: &Path) -> Vec<String> {
        lire(f, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", |r| r.get(0))
    }
    fn tache(id: &str, kind: &str, state: &str) -> Tache {
        Tache { id: id.into(), kind: kind.into(), state: state.into(), ..Tache::default() }
    }
    fn avec(migrations: &[&str]) -> Vec<String> {
        MIGRATIONS.iter().map(|s| s.to_string()).chain(migrations.iter().map(|s| s.to_string())).collect()
    }
    fn refs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }
    const TABLES: [&str; 4] = ["file_hashes", "game_sessions", "optimizations", "tasks"];

    #[test]
    fn base_neuve() {
        let d = Dossier::nouveau("base-neuve");
        let f = fichier(&d);
        let b = Base::ouvrir(&f);
        assert!(b.disponible());
        assert_eq!((b.version(), b.probleme()), (N, None));
        b.fermer();
        b.fermer();
        assert_eq!(version(&f), N);
        assert_eq!(tables(&f), TABLES);
        assert_eq!(lire(&f, "PRAGMA journal_mode", |r| r.get::<_, String>(0))[0], "wal");
        assert!(!std::fs::read_dir(&d.0).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".avant-")));
    }

    #[test]
    fn migration_avec_copie_et_deux_copies_au_plus() {
        let d = Dossier::nouveau("base-migration");
        let f = fichier(&d);
        let b = Base::ouvrir(&f);
        b.enregistrer_tache(&Tache { created_at: Some(maintenant()), ..tache("t1", "backup", "done") });
        b.fermer();
        let suivante = avec(&["CREATE TABLE extra1 (a TEXT)"]);
        let b = Base::ouvrir_avec(&f, &refs(&suivante), maintenant);
        assert_eq!(b.version(), N + 1);
        assert_eq!(b.taches_recentes(50).len(), 1);
        b.fermer();
        let copie = PathBuf::from(format!("{}.avant-v{}", f.display(), N + 1));
        assert_eq!(version(&copie), N);
        assert_eq!(lire(&copie, "SELECT id FROM tasks", |r| r.get::<_, String>(0)), ["t1"]);
        for n in [2, 3] {
            let m = avec(
                &(1..=n)
                    .map(|i| format!("CREATE TABLE extra{i} (a TEXT)"))
                    .collect::<Vec<_>>()
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            );
            Base::ouvrir_avec(&f, &refs(&m), maintenant).fermer();
        }
        let mut copies: Vec<String> = std::fs::read_dir(&d.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.contains(".avant-v"))
            .collect();
        copies.sort();
        assert_eq!(copies, [format!("launcher.db.avant-v{}", N + 2), format!("launcher.db.avant-v{}", N + 3)]);
        assert_eq!(version(&f), N + 3);
    }

    #[test]
    fn migration_en_echec_ne_change_rien() {
        let d = Dossier::nouveau("base-echec");
        let f = fichier(&d);
        let b = Base::ouvrir(&f);
        b.enregistrer_tache(&tache("t1", "backup", "done"));
        b.fermer();
        let cassee = avec(&["CREATE TABLE ok (a); CREATE TABLE tasks (a)"]);
        let b = Base::ouvrir_avec(&f, &refs(&cassee), maintenant);
        assert!(!b.disponible());
        assert_eq!(b.probleme(), Some(Probleme::Erreur));
        assert_eq!(b.enregistrer_tache(&tache("t2", "x", "done")), None);
        assert!(b.taches_recentes(50).is_empty());
        b.fermer();
        assert_eq!(version(&f), N);
        assert_eq!(tables(&f), TABLES);
        assert_eq!(lire(&f, "SELECT count(*) FROM tasks", |r| r.get::<_, i64>(0))[0], 1);
    }

    #[test]
    fn base_illisible_mise_de_cote() {
        let d = Dossier::nouveau("base-abimee");
        let f = fichier(&d);
        let dechet = "pas une base SQLite ".repeat(300);
        std::fs::write(&f, &dechet).unwrap();
        fn quand() -> i64 {
            chrono::NaiveDate::from_ymd_opt(2026, 11, 9)
                .unwrap()
                .and_hms_opt(21, 5, 7)
                .unwrap()
                .and_local_timezone(chrono::Local)
                .unwrap()
                .timestamp_millis()
        }
        let b = Base::ouvrir_avec(&f, &MIGRATIONS, quand);
        assert!(b.disponible());
        assert_eq!(b.version(), N);
        b.fermer();
        assert_eq!(std::fs::read_to_string(d.0.join("launcher.db.abimee-2026-11-09_21-05-07")).unwrap(), dechet);
        assert_eq!(version(&f), N);
    }

    #[test]
    fn base_plus_recente_laissee() {
        let d = Dossier::nouveau("base-recente");
        let f = fichier(&d);
        let future = avec(&["CREATE TABLE future (a)"]);
        Base::ouvrir_avec(&f, &refs(&future), maintenant).fermer();
        let avant = std::fs::read(&f).unwrap();
        let b = Base::ouvrir(&f);
        assert!(!b.disponible());
        assert_eq!(b.probleme(), Some(Probleme::PlusRecente));
        assert_eq!(b.debut_session("survie", None, None, None), None);
        b.fermer();
        assert_eq!(version(&f), N + 1);
        assert_eq!(std::fs::read(&f).unwrap(), avant);
    }

    #[test]
    fn dossier_impossible() {
        let d = Dossier::nouveau("base-bloquee");
        d.ecrire("fichier", "");
        let b = Base::ouvrir(&d.0.join("fichier").join("launcher.db"));
        assert!(!b.disponible());
        assert_eq!(b.probleme(), Some(Probleme::Erreur));
        assert_eq!(b.fin_session(Some(1), "exited", None, None), None);
        assert!(b.sessions_recentes("survie", 50).is_empty());
    }

    #[test]
    fn taches_et_menage() {
        let d = Dossier::nouveau("base-taches");
        let f = fichier(&d);
        let b = Base::ouvrir(&f);
        let p = json!({ "projectId": "p1" }).as_object().cloned();
        b.enregistrer_tache(&Tache {
            label: Some("Installation de X".into()),
            created_at: Some(1000),
            started_at: Some(1001),
            params: p.clone(),
            ..tache("a", "modpack-install", "running")
        });
        b.enregistrer_tache(&Tache {
            instance_id: Some("survie".into()),
            created_at: Some(2000),
            ended_at: Some(2500),
            ..tache("b", "world-backup", "cancelled")
        });
        b.enregistrer_tache(&Tache {
            created_at: Some(1000),
            ended_at: Some(3000),
            error: Some("Réseau".into()),
            params: p,
            ..tache("a", "modpack-install", "failed")
        });
        let l = b.taches_recentes(50);
        assert_eq!(
            l.iter().map(|r| (r["id"].clone(), r["state"].clone())).collect::<Vec<_>>(),
            [(json!("b"), json!("cancelled")), (json!("a"), json!("failed"))]
        );
        assert_eq!(l[1]["params"], json!({ "projectId": "p1" }));
        assert_eq!((l[1]["error"].as_str(), l[0]["instance_id"].as_str()), (Some("Réseau"), Some("survie")));
        b.fermer();

        let maintenant = maintenant();
        let b = Base::ouvrir(&f);
        b.enregistrer_tache(&Tache {
            created_at: Some(maintenant - 100 * 86_400_000),
            ended_at: Some(maintenant - 100 * 86_400_000),
            ..tache("vieille", "x", "done")
        });
        for i in 0..1005 {
            b.enregistrer_tache(&Tache {
                created_at: Some(maintenant - 1000 + i),
                ended_at: Some(maintenant),
                ..tache(&format!("t{i}"), "x", "done")
            });
        }
        b.fermer();
        let b = Base::ouvrir(&f);
        let ids: Vec<String> = b.taches_recentes(2000).into_iter().map(|r| r["id"].as_str().unwrap().to_string()).collect();
        b.fermer();
        assert_eq!(ids.len(), 1000);
        assert!(!ids.contains(&"vieille".into()) && ids.contains(&"t1004".into()) && !ids.contains(&"t0".into()));
    }

    #[test]
    fn progression_et_travail_de_fond_dans_params() {
        let d = Dossier::nouveau("base-params");
        let b = Base::ouvrir(&fichier(&d));
        let o = |v: Value| v.as_object().cloned();
        b.enregistrer_tache(&Tache {
            created_at: Some(1),
            params: o(json!({ "title": "X" })),
            progress: o(json!({ "done": 25, "total": 25, "totalBytes": 1500 })),
            ..tache("a", "modpack-install", "done")
        });
        b.enregistrer_tache(&Tache { created_at: Some(2), hidden: true, progress: o(json!({})), ..tache("b", "temp-cleanup", "done") });
        b.enregistrer_tache(&Tache { created_at: Some(3), ..tache("c", "x", "running") });
        let l = b.taches_recentes(50);
        let vue = |r: &Map<String, Value>| (r["params"].clone(), r["progress"].clone(), r["hidden"].clone());
        assert_eq!(vue(&l[2]), (json!({ "title": "X" }), json!({ "done": 25, "total": 25, "totalBytes": 1500 }), json!(false)));
        assert_eq!(vue(&l[1]), (Value::Null, Value::Null, json!(true)));
        assert_eq!(vue(&l[0]), (Value::Null, Value::Null, json!(false)));
        b.effacer_taches();
        assert_eq!(b.taches_recentes(50).iter().map(|r| r["id"].clone()).collect::<Vec<_>>(), [json!("c")]);
        b.fermer();
    }

    #[test]
    fn sessions_de_jeu() {
        let d = Dossier::nouveau("base-sessions");
        let b = Base::ouvrir(&fichier(&d));
        let id = b.debut_session("survie", Some("1.21.1"), Some("fabric"), Some(10_000)).unwrap();
        b.session_prete(Some(id), Some(14_500));
        b.fin_session(Some(id), "crashed", Some(1), Some(70_000));
        let autre = b.debut_session("survie", None, None, Some(80_000));
        b.fin_session(autre, "cancelled", None, Some(81_000));
        b.debut_session("creatif", None, None, Some(90_000));
        assert_eq!(b.session_prete(None, None), None);
        let s = b.sessions_recentes("survie", 50);
        assert_eq!(
            Value::Array(s.into_iter().map(Value::Object).collect()),
            json!([
                { "id": autre, "instance_id": "survie", "version": null, "loader": null, "started_at": 80_000, "ready_at": null, "ended_at": 81_000, "outcome": "cancelled", "exit_code": null, "prepare_ms": null, "menu_ms": null, "peak_memory": null },
                { "id": id, "instance_id": "survie", "version": "1.21.1", "loader": "fabric", "started_at": 10_000, "ready_at": 14_500, "ended_at": 70_000, "outcome": "crashed", "exit_code": 1, "prepare_ms": 4500, "menu_ms": null, "peak_memory": null }
            ])
        );
        b.fermer();
    }

    #[test]
    fn migration_2_depuis_la_0_5() {
        let d = Dossier::nouveau("base-v2");
        let f = fichier(&d);
        let vieille = Base::ouvrir_avec(&f, &MIGRATIONS[..1], maintenant);
        let id = vieille.debut_session("survie", None, None, Some(1000));
        vieille.session_prete(id, Some(2500));
        vieille.fermer();
        let b = Base::ouvrir(&f);
        assert_eq!(b.version(), N);
        assert!(PathBuf::from(format!("{}.avant-v{N}", f.display())).exists());
        b.session_menu(id, Some(12_300));
        b.session_pic(id, 5_000_000_000.0);
        b.session_pic(id, 4_000_000_000.0);
        let attendu = DernierLancement { started_at: 1000, prepare_ms: Some(1500), menu_ms: Some(9800), peak_memory: Some(5_000_000_000) };
        assert_eq!(b.dernier_lancement("survie"), Some(attendu));
        b.session_menu(id, Some(99_000));
        assert_eq!(b.dernier_lancement("survie").unwrap().menu_ms, Some(9800));
        assert_eq!(b.dernier_lancement("creatif"), None);
        b.fermer();
    }

    #[test]
    fn empreintes() {
        let d = Dossier::nouveau("base-empreintes");
        let b = Base::ouvrir(&fichier(&d));
        assert_eq!(b.empreinte("C:/mods/a.jar", 10, 5.5), None);
        b.noter_empreinte("C:/mods/a.jar", 10, 5.5, "abc", Some(&json!({ "name": "A", "modId": "a" })));
        assert_eq!(b.empreinte("C:/mods/a.jar", 10, 5.5), Some(("abc".into(), Some(json!({ "name": "A", "modId": "a" })))));
        assert_eq!(b.empreinte("C:/mods/a.jar", 11, 5.5), None);
        assert_eq!(b.empreinte("C:/mods/a.jar", 10, 6.0), None);
        b.fermer();
    }

    #[test]
    fn optimisations() {
        let d = Dossier::nouveau("base-optimisations");
        let b = Base::ouvrir(&fichier(&d));
        let a = b.ajouter_optimisation("survie", "ram", Some(&json!({ "from": 6, "to": 9 })), "dir-a", None, Some(1)).unwrap();
        let o2 = b.ajouter_optimisation("survie", "perf-pack", None, "dir-b", None, Some(2)).unwrap();
        b.changer_ajouts_optimisation(o2, &json!(["sodium.jar"]));
        b.ajouter_optimisation("creatif", "ram", None, "dir-c", None, Some(3));
        let l: Vec<_> = b.optimisations("survie").into_iter().map(|o| (o.id, o.kind, o.summary, o.snapshot, o.added)).collect();
        assert_eq!(
            l,
            [
                (o2, "perf-pack".to_string(), None, "dir-b".to_string(), json!(["sodium.jar"])),
                (a, "ram".to_string(), Some(json!({ "from": 6, "to": 9 })), "dir-a".to_string(), json!([])),
            ]
        );
        b.retirer_optimisations(&[a, o2]);
        assert!(b.optimisations("survie").is_empty());
        b.fermer();
    }
}
