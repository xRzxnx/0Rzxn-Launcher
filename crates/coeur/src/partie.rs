//! Partie en cours, comme services/launches.js : préparation, lancement, logs envoyés à l'interface, mesures du jeu,
//! menu atteint, fin de partie et plantage. Une seule partie (ou préparation) à la fois.

use crate::arguments::QuickPlay;
use crate::base::Base;
use crate::comptes;
use crate::crashes;
use crate::erreur::{Erreur, Resultat};
use crate::i18n::{t, tv};
use crate::instances;
use crate::jeu::Jeu;
use crate::lancement::{self, Evenement, Session, fichier_quick_play};
use crate::mesures;
use crate::sortie_jeu::LigneJeu;
use crate::taches::{Demande, Etape, Gestionnaire, Progres};
use futures_util::FutureExt;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const LOGS_GARDES: usize = 5000;
const INTERVALLE_MESURES: Duration = Duration::from_secs(2);
const PIC_ECRIT_MS: i64 = 30_000;
/// Menu du jeu atteint : cette ligne apparaît quand le son démarre, juste avant l'écran titre.
const LIGNE_MENU: &str = "Sound engine started";

/// Ce que la fenêtre fait autour de la partie (réglage « Après le lancement »).
pub trait Fenetre: Send + Sync {
    fn minimiser(&self);
    fn masquer(&self);
    /// Fin de partie : la fenêtre revient devant.
    fn montrer(&self);
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub instance_id: String,
    /// preparing | running
    pub phase: &'static str,
    pub step: usize,
    pub done: u64,
    pub total: u64,
    pub prepare_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepare_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menu_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mesures {
    pub instance_id: String,
    pub memory: Option<u64>,
    pub peak: Option<u64>,
    pub cpu: Option<u32>,
    pub allocated: u64,
}

/// Progression de la tâche « préparation », connue une fois la tâche démarrée.
type ProgresPartage = Arc<Mutex<Option<Progres>>>;

#[derive(Default)]
struct Etat {
    arret: Option<CancellationToken>,
    run: Option<Run>,
    logs: VecDeque<LigneJeu>,
    en_attente: Vec<LigneJeu>,
    envoi_prevu: bool,
    /// Trop de lignes en attente : l'interface reçoit tout le tampon d'un coup.
    resync: bool,
    session_id: Option<i64>,
    lance_a: i64,
    pret_a: Option<i64>,
    menu_a: Option<i64>,
    mesures: Option<Mesures>,
    fin_mesures: Option<CancellationToken>,
    pic_ecrit_a: i64,
    /// La préparation est aussi une tâche de l'Activité : elle finit au démarrage du jeu.
    tache: Option<(oneshot::Sender<Resultat<Value>>, ProgresPartage)>,
}

pub type Envoi = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct Parties {
    pub jeu: Arc<Jeu>,
    base: Arc<Base>,
    taches: Arc<Gestionnaire>,
    /// Dossier des réglages (accounts.json).
    donnees: PathBuf,
    version_launcher: String,
    envoyer: Envoi,
    fenetre: Option<Arc<dyn Fenetre>>,
    etat: Mutex<Etat>,
    moi: Weak<Parties>,
}

fn maintenant() -> i64 {
    crate::base::maintenant()
}

fn secondes(ms: i64) -> String {
    let t = format!("{:.1}", ms as f64 / 1000.0);
    if crate::i18n::langue() == "en" { t } else { t.replace('.', ",") }
}

pub struct Options {
    pub jeu: Arc<Jeu>,
    pub base: Arc<Base>,
    pub taches: Arc<Gestionnaire>,
    pub donnees: PathBuf,
    pub version_launcher: String,
    pub envoyer: Envoi,
    pub fenetre: Option<Arc<dyn Fenetre>>,
}

impl Parties {
    pub fn new(o: Options) -> Arc<Self> {
        Arc::new_cyclic(|moi| Self {
            jeu: o.jeu,
            base: o.base,
            taches: o.taches,
            donnees: o.donnees,
            version_launcher: o.version_launcher,
            envoyer: o.envoyer,
            fenetre: o.fenetre,
            etat: Mutex::default(),
            moi: moi.clone(),
        })
    }

    fn etat(&self) -> std::sync::MutexGuard<'_, Etat> {
        self.etat.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn racine(&self) -> &Path {
        &self.jeu.dossiers.racine
    }

    /// Instance en cours de partie ou de préparation (ses tâches attendent la fin).
    pub fn instance_en_jeu(&self) -> Option<String> {
        self.etat().run.as_ref().map(|r| r.instance_id.clone())
    }

    pub fn en_cours(&self) -> bool {
        self.etat().arret.is_some()
    }

    fn statut(&self, extra: Value) {
        let run = self.etat().run.clone();
        let mut v = json!({ "run": run });
        if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
            o.extend(e);
        }
        (self.envoyer)("launch:status", v);
    }

    /// Monde ou serveur demandé par l'interface : un monde doit exister dans l'instance, une adresse rester une adresse.
    pub fn cible_quick_play(&self, id: &str, cible: Option<&Value>) -> Resultat<Option<QuickPlay>> {
        let Some(c) = cible else { return Ok(None) };
        let champ = |n: &str| c.get(n).and_then(Value::as_str).unwrap_or("").to_string();
        let genre = champ("type");
        let name: String = champ("name").chars().take(100).collect();
        match genre.as_str() {
            "singleplayer" => {
                let dossier = champ("id");
                if dossier.is_empty()
                    || dossier.contains(['/', '\\'])
                    || dossier == "."
                    || dossier == ".."
                    || dossier.starts_with(".restauration-")
                {
                    return Err(Erreur::new(t("worlds.monde_invalide")));
                }
                let saves = instances::dossier(self.racine(), id).join("minecraft").join("saves");
                if !saves.join(&dossier).join("level.dat").is_file() {
                    return Err(Erreur::new(t("worlds.monde_introuvable")));
                }
                Ok(Some(QuickPlay { genre, id: dossier, name }))
            }
            "multiplayer" => {
                let adresse = champ("id").trim().to_string();
                let ok = (1..=255).contains(&adresse.len()) && adresse.chars().all(|ch| ch.is_alphanumeric() || "_.-:[]".contains(ch));
                if !ok {
                    return Err(Erreur::new(t("ipc.adresse_de_serveur_invalide")));
                }
                Ok(Some(QuickPlay { genre, id: adresse, name }))
            }
            _ => Ok(None),
        }
    }

    /// Démarre la préparation (et le jeu, sauf `preparer_seulement`). Renvoie l'état de la partie.
    pub fn demarrer(&self, instance_id: &str, verifier: bool, preparer_seulement: bool, quick_play: Option<QuickPlay>) -> Resultat<Run> {
        if self.en_cours() {
            return Err(Erreur::new(t("ipc.une_partie_ou_une_installation")));
        }
        let instance = instances::lire(self.racine(), instance_id).ok_or_else(|| Erreur::new(t("instances.instance_introuvable")))?;
        let compte_id = comptes::choisir(&self.donnees, instance.account_id.as_deref())
            .ok_or_else(|| Erreur::new(t("common.ajoute_un_compte_avant_de")))?;
        // Une tâche longue (sauvegarde, mise à jour…) touche cette instance : la partie attend qu'elle finisse.
        if let Some(occupee) = self.taches.en_cours_sur(instance_id) {
            return Err(Erreur::new(tv("ipc.patiente_est_en_cours", &[("task", &occupee.label)])));
        }

        let arret = CancellationToken::new();
        let run = Run { instance_id: instance_id.into(), phase: "preparing", prepare_only: preparer_seulement, ..Default::default() };
        let session_id = self.base.debut_session(instance_id, Some(&instance.version), Some(&instance.loader), None);
        {
            let mut e = self.etat();
            e.arret = Some(arret.clone());
            e.run = Some(run.clone());
            e.logs.clear();
            e.en_attente.clear();
            e.resync = false;
            e.session_id = session_id;
            e.lance_a = maintenant();
            e.pret_a = None;
            e.menu_a = None;
            e.mesures = None;
        }
        (self.envoyer)("launch:reset", Value::Null);
        self.statut(json!({}));
        self.suivre_preparation(&instance.name, instance_id, preparer_seulement, arret.clone());

        let choisi_absent = instance.account_id.as_deref().is_some_and(|a| a != compte_id);
        let donnees = self.donnees.clone();
        let moi = self.moi.clone();
        let session = Session {
            jeu: self.jeu.clone(),
            dossier_instance: instances::dossier(self.racine(), instance_id),
            compte: Box::new(move |log| {
                async move {
                    if choisi_absent {
                        log(&t("ipc.le_compte_choisi_pour_cette"));
                    }
                    comptes::compte_de_jeu(&donnees, &compte_id)
                }
                .boxed()
            }),
            version_launcher: self.version_launcher.clone(),
            verifier,
            preparer_seulement,
            quick_play,
            arret,
            rappel: Arc::new(move |ev| {
                if let Some(p) = moi.upgrade() {
                    p.evenement(ev);
                }
            }),
            instance,
        };
        tokio::spawn(lancement::lancer(session));
        Ok(run)
    }

    /// Préparation visible dans la page Activité, finie quand le jeu démarre ou que les fichiers sont prêts.
    /// Annuler la tâche arrête la préparation.
    fn suivre_preparation(&self, nom: &str, instance_id: &str, preparer_seulement: bool, arret: CancellationToken) {
        let (tx, rx) = oneshot::channel::<Resultat<Value>>();
        let progres: ProgresPartage = Arc::default();
        self.etat().tache = Some((tx, progres.clone()));
        let label = tv(if preparer_seulement { "ipc.verification_de" } else { "ipc.preparation_de_la_partie" }, &[("name", nom)]);
        let mut d = Demande::new(
            "launch-prepare",
            label,
            Box::new(move |ctx| {
                *progres.lock().unwrap_or_else(|e| e.into_inner()) = Some(ctx.progres);
                async move {
                    let annule = ctx.annule;
                    tokio::select! {
                        r = rx => r.unwrap_or(Ok(Value::Null)),
                        _ = annule.cancelled() => {
                            arret.cancel();
                            Err(Erreur::code(t("launch.lancement_annule"), "CANCELLED"))
                        }
                    }
                }
                .boxed()
            }),
        );
        d.instance_id = Some(instance_id.into());
        d.immediate = true;
        d.cancellable = true;
        d.params = json!({ "name": nom, "prepareOnly": preparer_seulement });
        // L'échec est déjà montré par l'accueil (launch:status).
        tokio::spawn(self.taches.lancer(d));
    }

    fn finir_tache(&self, r: Resultat<Value>) {
        if let Some((tx, _)) = self.etat().tache.take() {
            let _ = tx.send(r);
        }
    }

    fn evenement(&self, ev: Evenement) {
        match ev {
            Evenement::Journal(l) => self.ajouter_log(l),
            Evenement::Progres { etape, fait, total, octets } => {
                let (run, progres) = {
                    let mut e = self.etat();
                    let progres = e.tache.as_ref().and_then(|(_, p)| p.lock().unwrap_or_else(|x| x.into_inner()).clone());
                    let Some(r) = e.run.as_mut() else { return };
                    r.step = etape;
                    r.done = fait;
                    r.total = total;
                    // Octets, vitesse et temps restant du téléchargement en cours ; retirés hors téléchargement.
                    r.done_bytes = octets.map(|o| o.octets_faits);
                    r.total_bytes = octets.map(|o| o.octets_total);
                    r.speed = octets.and_then(|o| o.vitesse);
                    r.eta = octets.and_then(|o| o.reste);
                    (r.clone(), progres)
                };
                if let Some(p) = progres {
                    p(Etape {
                        done: fait,
                        total,
                        step: Some(etape as u64),
                        done_bytes: run.done_bytes,
                        total_bytes: run.total_bytes,
                        speed: run.speed,
                        eta: run.eta.map(|s| s as f64),
                        ..Default::default()
                    });
                }
                (self.envoyer)("launch:progress", serde_json::to_value(run).unwrap_or_default());
            }
            Evenement::LoaderInstalle(version) => {
                if let Some(id) = self.instance_en_jeu() {
                    let _ = instances::marquer_loader_installe(self.racine(), &id, &version);
                }
            }
            Evenement::Pret => {
                let sid = self.etat().session_id;
                self.base.fin_session(sid, "prepared", None, None);
                self.finir_tache(Ok(Value::Null));
                self.finir(json!({ "prepared": true }));
            }
            Evenement::Echec { message, annule, code } => {
                let sid = self.etat().session_id;
                self.base.fin_session(sid, if annule { "cancelled" } else { "failed" }, None, None);
                self.finir_tache(Err(if annule { Erreur::code(message.clone(), "CANCELLED") } else { Erreur::new(message.clone()) }));
                let mut extra = json!({ "error": if annule { Value::Null } else { message.into() }, "cancelled": annule });
                if let Some(c) = code {
                    extra["errorCode"] = c.into();
                }
                self.finir(extra);
            }
            Evenement::Demarre { pid } => self.demarre(pid),
            Evenement::Fin { code, plante, minutes } => self.fin_de_partie(code, plante, minutes),
        }
    }

    fn demarre(&self, pid: u32) {
        let (sid, instance_id) = {
            let mut e = self.etat();
            let quand = maintenant();
            e.pret_a = Some(quand);
            let (lance, sid) = (e.lance_a, e.session_id);
            let Some(r) = e.run.as_mut() else { return };
            r.phase = "running";
            r.started_at = Some(quand);
            r.prepare_ms = Some(quand - lance);
            (sid, r.instance_id.clone())
        };
        self.base.session_prete(sid, None);
        self.finir_tache(Ok(Value::Null));
        let instance = instances::lire(self.racine(), &instance_id);
        if let Some(i) = &instance {
            self.mesurer(pid, i);
        }
        self.statut(json!({}));
        if let (Some(f), Some(i)) = (&self.fenetre, &instance) {
            match i.settings.after_launch.as_str() {
                "minimize" => f.minimiser(),
                "hide" => f.masquer(),
                _ => {}
            }
        }
    }

    fn fin_de_partie(&self, code: Option<i32>, plante: bool, minutes: u64) {
        self.arreter_mesures(true);
        let (sid, instance_id, debut) = {
            let e = self.etat();
            (e.session_id, e.run.as_ref().map(|r| r.instance_id.clone()).unwrap_or_default(), e.run.as_ref().and_then(|r| r.started_at))
        };
        self.base.fin_session(sid, if plante { "crashed" } else { "exited" }, code.map(i64::from), None);
        let _ = instances::noter_partie(self.racine(), &instance_id, minutes, maintenant());
        self.garder_quick_play(&instance_id);
        if let Some(f) = &self.fenetre {
            f.montrer();
        }
        let depuis = debut.unwrap_or_else(|| maintenant() - (minutes as i64 + 1) * 60_000);
        let crash = if plante { self.garder_crash(&instance_id, depuis, code) } else { Value::Null };
        self.finir(json!({ "exited": true, "code": code, "crashed": plante, "crash": crash }));
    }

    /// Rapport du plantage : celui écrit par le jeu ou par Java, sinon les logs de la partie, gardés par le launcher.
    fn garder_crash(&self, instance_id: &str, depuis: i64, code: Option<i32>) -> Value {
        let inst = instances::dossier(self.racine(), instance_id);
        let jeu = inst.join("minecraft");
        let d = crashes::Dossiers { jeu: &jeu, instance: &inst };
        if let Some(r) = crashes::lister(&d).into_iter().find(|c| c.source != "log" && c.at >= (depuis - 5000) as f64) {
            return json!({ "source": r.source, "file": r.file });
        }
        let lignes: Vec<LigneJeu> = self.etat().logs.iter().cloned().collect();
        match crashes::garder_log(&inst, &lignes, code) {
            Ok(f) => json!({ "source": "log", "file": f }),
            Err(_) => Value::Null,
        }
    }

    /// Monde ou serveur rejoint pendant la partie, noté par le jeu (1.20 et plus) : il rejoint la liste « Reprendre ».
    fn garder_quick_play(&self, instance_id: &str) {
        let f = fichier_quick_play(&instances::dossier(self.racine(), instance_id));
        if let Some(v) = crate::fichiers::lire_json::<Value>(&f) {
            let entree = if v.is_array() { v.get(0).cloned().unwrap_or(Value::Null) } else { v };
            let texte = |n: &str| match entree.get(n) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => String::new(),
            };
            let (genre, id) = (texte("type"), texte("id"));
            if !genre.is_empty() && !id.is_empty() {
                let _ = instances::noter_quick_play(self.racine(), instance_id, &genre, &id, &texte("name"), maintenant());
            }
        }
        let _ = std::fs::remove_file(f);
    }

    fn ajouter_log(&self, l: LigneJeu) {
        let menu = {
            let mut e = self.etat();
            let menu = e.menu_a.is_none() && e.pret_a.is_some() && l.msg.contains(LIGNE_MENU);
            e.logs.push_back(l.clone());
            while e.logs.len() > LOGS_GARDES {
                e.logs.pop_front();
            }
            e.en_attente.push(l);
            if e.en_attente.len() > LOGS_GARDES {
                let trop = e.en_attente.len() - LOGS_GARDES;
                e.en_attente.drain(..trop);
                e.resync = true;
            }
            menu
        };
        if menu {
            self.menu_atteint();
        }
        self.prevoir_envoi();
    }

    fn prevoir_envoi(&self) {
        {
            let mut e = self.etat();
            if e.envoi_prevu {
                return;
            }
            e.envoi_prevu = true;
        }
        let moi = self.moi.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Some(p) = moi.upgrade() {
                p.envoyer_logs();
            }
        });
    }

    // shortcut: le mode léger (logs retenus fenêtre cachée, fenêtre fermée pendant la partie) arrive avec le bureau (R6).
    fn envoyer_logs(&self) {
        let (lignes, tout) = {
            let mut e = self.etat();
            e.envoi_prevu = false;
            if e.en_attente.is_empty() {
                return;
            }
            let resync = std::mem::take(&mut e.resync);
            let lignes = std::mem::take(&mut e.en_attente);
            if resync { (e.logs.iter().cloned().collect::<Vec<_>>(), true) } else { (lignes, false) }
        };
        if tout {
            (self.envoyer)("launch:reset", Value::Null);
        }
        (self.envoyer)("launch:logs", serde_json::to_value(lignes).unwrap_or_default());
    }

    /// Menu du jeu atteint : noté avec la partie et signalé dans la console par une ligne du launcher.
    fn menu_atteint(&self) {
        let quand = maintenant();
        let (sid, run) = {
            let mut e = self.etat();
            e.menu_a = Some(quand);
            let (pret, lance) = (e.pret_a.unwrap_or(quand), e.lance_a);
            let heure = chrono::DateTime::from_timestamp_millis(quand)
                .unwrap_or_default()
                .with_timezone(&chrono::Local)
                .format("%H:%M:%S")
                .to_string();
            let mut ligne = LigneJeu::new(
                heure,
                "LAUNCHER",
                tv("launch.menu_atteint", &[("game", &secondes(quand - pret)), ("total", &secondes(quand - lance))]),
            );
            ligne.mark = true;
            e.logs.push_back(ligne.clone());
            e.en_attente.push(ligne);
            if let Some(r) = e.run.as_mut() {
                r.menu_ms = Some(quand - pret);
            }
            (e.session_id, e.run.clone())
        };
        self.base.session_menu(sid, Some(quand));
        if let Some(r) = run {
            (self.envoyer)("launch:progress", serde_json::to_value(r).unwrap_or_default());
        }
    }

    /// Mesures du jeu toutes les 2 s : mémoire, pic (écrit au plus toutes les 30 s) et processeur.
    fn mesurer(&self, pid: u32, instance: &commun::Instance) {
        let fin = CancellationToken::new();
        {
            let mut e = self.etat();
            e.mesures = Some(Mesures {
                instance_id: instance.id.clone(),
                memory: None,
                peak: None,
                cpu: None,
                allocated: (instance.settings.ram * 1024f64.powi(3)) as u64,
            });
            e.pic_ecrit_a = 0;
            e.fin_mesures = Some(fin.clone());
        }
        let moi = self.moi.clone();
        let coeurs = crate::performances::coeurs_logiques().max(1) as f64;
        tokio::spawn(async move {
            let mut avant: Option<(std::time::Instant, f64)> = None;
            loop {
                let Some(m) = tokio::task::spawn_blocking(move || mesures::mesurer(pid)).await.ok().flatten() else { return };
                let Some(p) = moi.upgrade() else { return };
                if fin.is_cancelled() {
                    return;
                }
                let maintenant_i = std::time::Instant::now();
                let cpu = avant.map(|(t, c)| {
                    let ecoule = maintenant_i.duration_since(t).as_secs_f64() * 1000.0;
                    ((m.cpu_ms - c) / (ecoule * coeurs) * 100.0).clamp(0.0, 100.0).round() as u32
                });
                avant = Some((maintenant_i, m.cpu_ms));
                p.noter_mesure(m.memoire, m.pic, cpu);
                drop(p);
                tokio::select! {
                    _ = tokio::time::sleep(INTERVALLE_MESURES) => {}
                    _ = fin.cancelled() => return,
                }
            }
        });
    }

    fn noter_mesure(&self, memoire: u64, pic: u64, cpu: Option<u32>) {
        let (charge, ecrire) = {
            let mut e = self.etat();
            let pic_ecrit_a = e.pic_ecrit_a;
            let Some(m) = e.mesures.as_mut() else { return };
            m.memory = Some(memoire);
            if cpu.is_some() {
                m.cpu = cpu;
            }
            let mut ecrire = None;
            if pic > m.peak.unwrap_or(0) {
                m.peak = Some(pic);
                if maintenant() - pic_ecrit_a >= PIC_ECRIT_MS {
                    ecrire = Some(pic);
                }
            }
            let charge = serde_json::to_value(&*m).unwrap_or_default();
            if ecrire.is_some() {
                e.pic_ecrit_a = maintenant();
            }
            (charge, ecrire.map(|p| (e.session_id, p)))
        };
        if let Some((sid, p)) = ecrire {
            self.base.session_pic(sid, p as f64);
        }
        (self.envoyer)("launch:metrics", charge);
    }

    /// Fin de la partie : plus de mesures ; `ecrire` garde le dernier pic connu.
    fn arreter_mesures(&self, ecrire: bool) {
        let (sid, pic) = {
            let mut e = self.etat();
            if let Some(f) = e.fin_mesures.take() {
                f.cancel();
            }
            (e.session_id, e.mesures.as_ref().and_then(|m| m.peak))
        };
        if ecrire && let Some(p) = pic {
            self.base.session_pic(sid, p as f64);
        }
    }

    fn finir(&self, extra: Value) {
        self.arreter_mesures(false);
        let instance_id = {
            let mut e = self.etat();
            e.arret = None;
            e.mesures = None;
            e.run.take().map(|r| r.instance_id)
        };
        // Les tâches qui attendaient la fin de la partie sur cette instance peuvent démarrer.
        self.taches.pomper();
        // Les derniers logs partent avant le changement d'état.
        self.envoyer_logs();
        let mut extra = extra;
        extra["instanceId"] = instance_id.map_or(Value::Null, Value::String);
        self.statut(extra);
    }

    /// Arrête la préparation ou le jeu.
    pub fn arreter(&self) {
        if let Some(a) = &self.etat().arret {
            a.cancel();
        }
    }

    /// État pour une interface qui s'ouvre.
    pub fn etat_courant(&self) -> Value {
        let e = self.etat();
        let mut v = Map::new();
        v.insert("run".into(), serde_json::to_value(&e.run).unwrap_or_default());
        v.insert("logs".into(), serde_json::to_value(&e.logs).unwrap_or_default());
        if e.run.as_ref().is_some_and(|r| r.phase == "running")
            && let Some(m) = &e.mesures
        {
            v.insert("metrics".into(), serde_json::to_value(m).unwrap_or_default());
        }
        Value::Object(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chemins::Dossiers;
    use crate::essai::Dossier;
    use crate::net::Reseau;
    use crate::taches::Options as OptionsTaches;

    type Envois = Arc<Mutex<Vec<(String, Value)>>>;

    fn parties(d: &Dossier) -> (Arc<Parties>, Envois) {
        let envois: Envois = Arc::default();
        let e = envois.clone();
        let base = Arc::new(Base::ouvrir(&d.0.join("donnees/launcher.db")));
        let p = Parties::new(Options {
            jeu: Jeu::new(Dossiers::new(&d.0.join("racine")), Arc::new(Reseau::new())),
            base,
            taches: Gestionnaire::new(OptionsTaches::default()),
            donnees: d.0.join("donnees"),
            version_launcher: "0.7.0".into(),
            envoyer: Arc::new(move |c, v| e.lock().unwrap().push((c.into(), v))),
            fenetre: None,
        });
        (p, envois)
    }

    #[tokio::test]
    async fn refus_avant_de_commencer_et_cibles() {
        let d = Dossier::nouveau("parties");
        d.ecrire("racine/instances/survie/instance.json", r#"{"id":"survie","name":"Survie","version":"1.21.11"}"#);
        d.ecrire("racine/instances/survie/minecraft/saves/Monde/level.dat", "");
        let (p, _) = parties(&d);
        assert!(p.demarrer("absente", false, false, None).unwrap_err().message.contains("Instance"));
        // Pas de compte : rien ne démarre.
        assert!(p.demarrer("survie", false, false, None).is_err());
        assert!(!p.en_cours());

        let monde = json!({ "type": "singleplayer", "id": "Monde", "name": "Mon monde" });
        assert_eq!(p.cible_quick_play("survie", Some(&monde)).unwrap().unwrap().id, "Monde");
        assert!(p.cible_quick_play("survie", Some(&json!({ "type": "singleplayer", "id": "Autre" }))).is_err());
        assert!(p.cible_quick_play("survie", Some(&json!({ "type": "singleplayer", "id": "../x" }))).is_err());
        let serveur = json!({ "type": "multiplayer", "id": " play.exemple.fr:25565 " });
        assert_eq!(p.cible_quick_play("survie", Some(&serveur)).unwrap().unwrap().id, "play.exemple.fr:25565");
        assert!(p.cible_quick_play("survie", Some(&json!({ "type": "multiplayer", "id": "a b" }))).is_err());
        assert_eq!(p.cible_quick_play("survie", Some(&json!({ "type": "realms", "id": "1" }))).unwrap(), None);
        assert_eq!(p.cible_quick_play("survie", None).unwrap(), None);
    }

    #[tokio::test]
    async fn echec_de_preparation_rapporte_et_note() {
        let d = Dossier::nouveau("parties-echec");
        d.ecrire("racine/instances/survie/instance.json", r#"{"id":"survie","name":"Survie","version":"inconnue-0"}"#);
        d.ecrire("donnees/accounts.json", r#"{"activeId":"o","accounts":[{"id":"o","type":"offline","name":"Steve","uuid":"u"}]}"#);
        let (p, envois) = parties(&d);
        // Manifeste vide gardé en mémoire : aucune requête, la version est introuvable.
        *p.jeu.manifeste.lock().unwrap() = Some(Arc::new(json!({ "versions": [] })));
        let run = p.demarrer("survie", false, false, None).unwrap();
        assert_eq!((run.phase, run.instance_id.as_str()), ("preparing", "survie"));
        assert!(p.demarrer("survie", false, false, None).is_err(), "une seule partie à la fois");
        for _ in 0..200 {
            if !p.en_cours() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!p.en_cours());
        let statuts: Vec<Value> = envois.lock().unwrap().iter().filter(|(c, _)| c == "launch:status").map(|(_, v)| v.clone()).collect();
        let dernier = statuts.last().unwrap();
        assert!(dernier["error"].as_str().unwrap().contains("inconnue-0"), "{dernier}");
        assert_eq!((dernier["run"].clone(), dernier["instanceId"].as_str()), (Value::Null, Some("survie")));
        let logs: Vec<String> = p.etat().logs.iter().map(|l| l.msg.clone()).collect();
        assert!(logs.iter().any(|l| l.contains("Steve")), "{logs:?}");
        let sessions = p.base.sessions_recentes("survie", 5);
        assert_eq!(sessions[0]["outcome"], "failed");
    }
}
