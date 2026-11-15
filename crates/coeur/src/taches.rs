//! Tâches longues (installation, sauvegarde, import, préparation d'une partie), comme services/tasks.js : file triée par
//! priorité, deux tâches à la fois, une seule par instance et jamais sur une instance en cours de partie, annulation,
//! événements vers l'interface (« tasks:changed », « task:progress ») et historique dans launcher.db.
//! La préparation d'une partie est « immédiate » : elle démarre tout de suite, hors limite.

use crate::base::{Base, Tache};
use crate::erreur::{Erreur, Resultat};
use crate::i18n::tv;
use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Au plus 10 envois par seconde de la liste des tâches.
const INTERVALLE_MS: i64 = 100;
const HISTORIQUE: i64 = 50;

/// Avancement d'une tâche ; octets, vitesse et temps restant (téléchargements) et étape (partie) quand ils sont connus.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Avancement {
    pub label: String,
    pub done: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<u64>,
}

/// Ce que le travail annonce : `label` absent = nom de la tâche.
#[derive(Debug, Clone, Default)]
pub struct Etape {
    pub label: Option<String>,
    pub done: u64,
    pub total: u64,
    pub done_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed: Option<f64>,
    pub eta: Option<f64>,
    pub step: Option<u64>,
}

pub type Progres = Arc<dyn Fn(Etape) + Send + Sync>;

pub struct Contexte {
    pub annule: CancellationToken,
    pub progres: Progres,
}

pub type Travail = Box<dyn FnOnce(Contexte) -> BoxFuture<'static, Resultat<Value>> + Send>;

pub struct Demande {
    pub kind: String,
    pub label: String,
    pub instance_id: Option<String>,
    /// high | normal | low
    pub priority: &'static str,
    pub cancellable: bool,
    /// Travail de fond : absent de l'Activité, ne compte pas comme occupé.
    pub hidden: bool,
    /// Démarre tout de suite, hors limite (préparation d'une partie).
    pub immediate: bool,
    pub params: Value,
    pub travail: Travail,
}

impl Demande {
    pub fn new(kind: &str, label: impl Into<String>, travail: Travail) -> Self {
        Self {
            kind: kind.into(),
            label: label.into(),
            instance_id: None,
            priority: "normal",
            cancellable: false,
            hidden: false,
            immediate: false,
            params: Value::Null,
            travail,
        }
    }
}

fn rang(p: &str) -> u8 {
    match p {
        "high" => 0,
        "low" => 2,
        _ => 1,
    }
}

/// Vue d'une tâche pour l'interface.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vue {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub instance_id: Option<String>,
    pub priority: &'static str,
    pub cancellable: bool,
    pub hidden: bool,
    pub immediate: bool,
    pub params: Value,
    /// queued | running | done | failed | cancelled
    pub state: &'static str,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub error: Option<String>,
    pub progress: Avancement,
}

struct Entree {
    vue: Vue,
    seq: u64,
    annule: CancellationToken,
    travail: Option<Travail>,
    reponse: Option<oneshot::Sender<Resultat<Value>>>,
}

#[derive(Default)]
struct Etat {
    taches: Vec<Entree>,
    seq: u64,
    /// Tâche dont « task:progress » montre la progression.
    montree: Option<String>,
    minuteur: Option<u64>,
    generation: u64,
    dernier_envoi: i64,
}

/// Historique des tâches finies (launcher.db).
pub trait Historique: Send + Sync {
    fn noter(&self, t: &Tache);
    fn recentes(&self, limite: i64) -> Vec<Map<String, Value>>;
    fn effacer(&self);
}

impl Historique for Base {
    fn noter(&self, t: &Tache) {
        self.enregistrer_tache(t);
    }
    fn recentes(&self, limite: i64) -> Vec<Map<String, Value>> {
        self.taches_recentes(limite)
    }
    fn effacer(&self) {
        self.effacer_taches();
    }
}

pub type Envoi = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct Gestionnaire {
    etat: Mutex<Etat>,
    envoyer: Envoi,
    historique: Option<Arc<dyn Historique>>,
    limite: usize,
    /// Instance en cours de partie : ses tâches attendent la fin.
    en_jeu: Box<dyn Fn(&str) -> bool + Send + Sync>,
    horloge: fn() -> i64,
    moi: Weak<Gestionnaire>,
}

/// « task:progress », inchangé depuis la phase 2 : l'interface n'attend que ces quatre champs.
fn charge_progres(v: &Vue) -> Value {
    json!({ "label": v.progress.label, "done": v.progress.done, "total": v.progress.total, "cancellable": v.cancellable })
}

pub struct Options {
    pub envoyer: Envoi,
    pub historique: Option<Arc<dyn Historique>>,
    pub limite: usize,
    pub en_jeu: Box<dyn Fn(&str) -> bool + Send + Sync>,
    pub horloge: fn() -> i64,
}

impl Default for Options {
    fn default() -> Self {
        Self { envoyer: Arc::new(|_, _| {}), historique: None, limite: 2, en_jeu: Box::new(|_| false), horloge: crate::base::maintenant }
    }
}

impl Gestionnaire {
    pub fn new(o: Options) -> Arc<Self> {
        Arc::new_cyclic(|moi| Self {
            etat: Mutex::default(),
            envoyer: o.envoyer,
            historique: o.historique,
            limite: o.limite,
            en_jeu: o.en_jeu,
            horloge: o.horloge,
            moi: moi.clone(),
        })
    }

    fn etat(&self) -> std::sync::MutexGuard<'_, Etat> {
        self.etat.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ajoute une tâche ; le futur rend le résultat du travail.
    pub fn lancer(&self, d: Demande) -> impl Future<Output = Resultat<Value>> + Send + 'static {
        let (tx, rx) = oneshot::channel();
        let maintenant = (self.horloge)();
        let (id, immediate) = {
            let mut e = self.etat();
            e.seq += 1;
            let id = format!("{}-{}", base36(maintenant), e.seq);
            let vue = Vue {
                id: id.clone(),
                kind: d.kind,
                progress: Avancement { label: d.label.clone(), ..Default::default() },
                label: d.label,
                instance_id: d.instance_id,
                priority: match d.priority {
                    "high" => "high",
                    "low" => "low",
                    _ => "normal",
                },
                cancellable: d.cancellable,
                hidden: d.hidden,
                immediate: d.immediate,
                params: d.params,
                state: "queued",
                created_at: maintenant,
                started_at: None,
                ended_at: None,
                error: None,
            };
            let seq = e.seq;
            e.taches.push(Entree { vue, seq, annule: CancellationToken::new(), travail: Some(d.travail), reponse: Some(tx) });
            (id, d.immediate)
        };
        if immediate {
            self.demarrer(&id);
        } else {
            self.change(true);
            self.pomper();
        }
        async move { rx.await.unwrap_or_else(|_| Err(Erreur::new("task lost"))) }
    }

    fn peut_demarrer(&self, e: &Etat, i: usize) -> bool {
        let t = &e.taches[i];
        let en_cours = || e.taches.iter().filter(|x| x.vue.state == "running");
        if en_cours().filter(|x| !x.vue.immediate).count() >= self.limite {
            return false;
        }
        match &t.vue.instance_id {
            Some(inst) => !en_cours().any(|x| x.vue.instance_id.as_ref() == Some(inst)) && !(self.en_jeu)(inst),
            None => true,
        }
    }

    /// Démarre ce qui peut l'être, par priorité puis ordre d'arrivée.
    pub fn pomper(&self) {
        loop {
            let suivante = {
                let e = self.etat();
                let mut attente: Vec<usize> = (0..e.taches.len()).filter(|&i| e.taches[i].vue.state == "queued").collect();
                attente.sort_by_key(|&i| (rang(e.taches[i].vue.priority), e.taches[i].seq));
                attente.into_iter().find(|&i| self.peut_demarrer(&e, i)).map(|i| e.taches[i].vue.id.clone())
            };
            match suivante {
                Some(id) => self.demarrer(&id),
                None => return,
            }
        }
    }

    fn demarrer(&self, id: &str) {
        let (travail, annule) = {
            let mut e = self.etat();
            let Some(t) = e.taches.iter_mut().find(|t| t.vue.id == id) else { return };
            t.vue.state = "running";
            t.vue.started_at = Some((self.horloge)());
            (t.travail.take(), t.annule.clone())
        };
        self.montrer_progres();
        self.change(true);
        let moi = self.moi.clone();
        let cle = id.to_string();
        let progres: Progres = Arc::new(move |p: Etape| {
            if let Some(g) = moi.upgrade() {
                g.avancer(&cle, p);
            }
        });
        let Some(travail) = travail else { return };
        let futur = travail(Contexte { annule: annule.clone(), progres });
        let moi = self.moi.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            let r = futur.await;
            if let Some(g) = moi.upgrade() {
                let etat = match &r {
                    Ok(_) => "done",
                    Err(e) if annule.is_cancelled() || e.a_le_code("CANCELLED") => "cancelled",
                    Err(_) => "failed",
                };
                g.regler(&id, etat, r);
            }
        });
    }

    fn avancer(&self, id: &str, p: Etape) {
        let charge = {
            let mut e = self.etat();
            let montree = e.montree.as_deref() == Some(id);
            let Some(t) = e.taches.iter_mut().find(|t| t.vue.id == id && t.vue.state == "running") else { return };
            t.vue.progress = Avancement {
                label: p.label.unwrap_or_else(|| t.vue.label.clone()),
                done: p.done,
                total: p.total,
                done_bytes: p.done_bytes,
                total_bytes: p.total_bytes,
                speed: p.speed,
                eta: p.eta,
                step: p.step,
            };
            montree.then(|| charge_progres(&t.vue))
        };
        if let Some(c) = charge {
            (self.envoyer)("task:progress", c);
        }
        self.change(false);
    }

    /// État final, décidé une seule fois.
    fn regler(&self, id: &str, etat: &'static str, r: Resultat<Value>) {
        let entree = {
            let mut e = self.etat();
            let Some(i) = e.taches.iter().position(|t| t.vue.id == id) else { return };
            let mut t = e.taches.remove(i);
            t.vue.state = etat;
            t.vue.ended_at = Some((self.horloge)());
            t.vue.error = r.as_ref().err().map(|e| e.message.clone());
            t
        };
        if let Some(h) = &self.historique {
            let mut progres = serde_json::to_value(&entree.vue.progress).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
            progres.remove("label");
            let v = &entree.vue;
            h.noter(&Tache {
                id: v.id.clone(),
                kind: v.kind.clone(),
                label: Some(v.label.clone()),
                instance_id: v.instance_id.clone(),
                state: etat.into(),
                created_at: Some(v.created_at),
                started_at: v.started_at,
                ended_at: v.ended_at,
                error: v.error.clone(),
                params: v.params.as_object().cloned(),
                progress: Some(progres),
                hidden: v.hidden,
            });
        }
        self.montrer_progres();
        self.change(true);
        if let Some(tx) = entree.reponse {
            let _ = tx.send(r);
        }
        self.pomper();
    }

    /// « task:progress » suit la plus ancienne tâche longue en cours ; null quand il n'y en a plus.
    fn montrer_progres(&self) {
        let charge = {
            let mut e = self.etat();
            let premiere = e
                .taches
                .iter()
                .filter(|t| t.vue.state == "running" && !t.vue.hidden && !t.vue.immediate)
                .min_by_key(|t| (t.vue.started_at.unwrap_or(0), t.seq));
            let id = premiere.map(|t| t.vue.id.clone());
            if id == e.montree {
                return;
            }
            let charge = premiere.map(|t| charge_progres(&t.vue)).unwrap_or(Value::Null);
            e.montree = id;
            charge
        };
        (self.envoyer)("task:progress", charge);
    }

    /// Annule une tâche : en attente, elle est retirée ; en cours, elle reçoit le signal si elle l'accepte.
    /// Sans identifiant : la tâche affichée.
    pub fn annuler(&self, id: Option<&str>) -> bool {
        let (etat, annule, cible, label) = {
            let e = self.etat();
            let Some(cible) = id.map(String::from).or_else(|| e.montree.clone()) else { return false };
            let Some(t) = e.taches.iter().find(|t| t.vue.id == cible) else { return false };
            (t.vue.state, t.vue.cancellable.then(|| t.annule.clone()), cible, t.vue.label.clone())
        };
        if etat == "queued" {
            self.regler(&cible, "cancelled", Err(Erreur::code(tv("ipc.tache_annulee_avant_debut", &[("task", &label)]), "CANCELLED")));
            return true;
        }
        match annule {
            Some(a) => {
                a.cancel();
                true
            }
            None => false,
        }
    }

    /// Tâche longue en cours sur cette instance (la partie ne démarre pas pendant ce temps).
    pub fn en_cours_sur(&self, instance: &str) -> Option<Vue> {
        let e = self.etat();
        e.taches
            .iter()
            .find(|t| t.vue.state == "running" && t.vue.instance_id.as_deref() == Some(instance) && !t.vue.immediate)
            .map(|t| t.vue.clone())
    }

    /// Une tâche visible en attente ou en cours.
    pub fn occupe(&self) -> bool {
        self.etat().taches.iter().any(|t| !t.vue.hidden)
    }

    /// Nom de la tâche affichée.
    pub fn actuelle(&self) -> Option<String> {
        let e = self.etat();
        let id = e.montree.as_ref()?;
        e.taches.iter().find(|t| &t.vue.id == id).map(|t| t.vue.label.clone())
    }

    /// Tâches en attente et en cours, dans l'ordre où elles passeront.
    pub fn liste(&self) -> Vec<Vue> {
        let e = self.etat();
        let mut l: Vec<&Entree> = e.taches.iter().collect();
        l.sort_by_key(|t| (t.vue.state != "running", rang(t.vue.priority), t.seq));
        l.into_iter().map(|t| t.vue.clone()).collect()
    }

    /// Dernières tâches finies, sans le travail de fond (lignes d'avant la phase 5 : reconnu à son type).
    pub fn recentes(&self, limite: Option<i64>) -> Vec<Value> {
        let n = limite.filter(|n| *n >= 1).unwrap_or(HISTORIQUE).min(HISTORIQUE);
        let Some(h) = &self.historique else { return vec![] };
        h.recentes(n * 2)
            .into_iter()
            .filter(|l| l.get("hidden") != Some(&Value::Bool(true)) && l.get("kind").and_then(Value::as_str) != Some("temp-cleanup"))
            .take(n as usize)
            .map(|l| {
                let c = |k: &str| l.get(k).cloned().unwrap_or(Value::Null);
                json!({
                    "id": c("id"), "kind": c("kind"), "label": c("label"), "instanceId": c("instance_id"), "state": c("state"),
                    "createdAt": c("created_at"), "startedAt": c("started_at"), "endedAt": c("ended_at"), "error": c("error"),
                    "params": c("params"), "progress": c("progress"),
                })
            })
            .collect()
    }

    pub fn effacer_historique(&self) {
        if let Some(h) = &self.historique {
            h.effacer();
        }
    }

    fn envoyer_liste(&self) {
        (self.envoyer)("tasks:changed", serde_json::to_value(self.liste()).unwrap_or_default());
    }

    /// « tasks:changed » : tout de suite pour un changement d'état, sinon au plus toutes les 100 ms.
    fn change(&self, immediat: bool) {
        let attente = {
            let mut e = self.etat();
            let maintenant = (self.horloge)();
            if immediat || tokio::runtime::Handle::try_current().is_err() {
                e.minuteur = None;
                e.dernier_envoi = maintenant;
                None
            } else if e.minuteur.is_some() {
                return;
            } else {
                e.generation += 1;
                e.minuteur = Some(e.generation);
                Some((e.generation, (INTERVALLE_MS - (maintenant - e.dernier_envoi)).max(0)))
            }
        };
        let Some((generation, ms)) = attente else {
            self.envoyer_liste();
            return;
        };
        let moi = self.moi.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms as u64)).await;
            let Some(g) = moi.upgrade() else { return };
            {
                let mut e = g.etat();
                if e.minuteur != Some(generation) {
                    return;
                }
                e.minuteur = None;
                e.dernier_envoi = (g.horloge)();
            }
            g.envoyer_liste();
        });
    }
}

fn base36(mut n: i64) -> String {
    const CHIFFRES: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n <= 0 {
        return "0".into();
    }
    let mut s = vec![];
    while n > 0 {
        s.push(CHIFFRES[(n % 36) as usize]);
        n /= 36;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Envois = Arc<Mutex<Vec<(String, Value)>>>;

    #[derive(Default)]
    struct Memoire(Mutex<Vec<Tache>>);
    impl Historique for Memoire {
        fn noter(&self, t: &Tache) {
            self.0.lock().unwrap().push(t.clone());
        }
        fn recentes(&self, _: i64) -> Vec<Map<String, Value>> {
            vec![]
        }
        fn effacer(&self) {}
    }

    fn installer(limite: usize, en_jeu: Box<dyn Fn(&str) -> bool + Send + Sync>) -> (Arc<Gestionnaire>, Envois, Arc<Memoire>) {
        let envois: Envois = Arc::default();
        let e = envois.clone();
        let h = Arc::new(Memoire::default());
        let g = Gestionnaire::new(Options {
            envoyer: Arc::new(move |c, v| e.lock().unwrap().push((c.into(), v))),
            historique: Some(h.clone()),
            limite,
            en_jeu,
            ..Default::default()
        });
        (g, envois, h)
    }

    fn messages(e: &Envois, canal: &str) -> Vec<Value> {
        e.lock().unwrap().iter().filter(|(c, _)| c == canal).map(|(_, v)| v.clone()).collect()
    }

    /// Tâche dont la fin est décidée par le test.
    struct Pilote {
        fin: Option<oneshot::Sender<Resultat<Value>>>,
        demarree: Arc<AtomicUsize>,
        contexte: Arc<Mutex<Option<(CancellationToken, Progres)>>>,
    }

    impl Pilote {
        fn finir(&mut self, r: Resultat<Value>) {
            let _ = self.fin.take().unwrap().send(r);
        }
        fn progres(&self, e: Etape) {
            (self.contexte.lock().unwrap().as_ref().unwrap().1)(e)
        }
        fn annulee(&self) -> bool {
            self.contexte.lock().unwrap().as_ref().unwrap().0.is_cancelled()
        }
    }

    fn piloter(g: &Gestionnaire, label: &str, regler: impl FnOnce(&mut Demande)) -> (Pilote, tokio::task::JoinHandle<Resultat<Value>>) {
        let (tx, rx) = oneshot::channel::<Resultat<Value>>();
        let demarree = Arc::new(AtomicUsize::new(0));
        let contexte = Arc::new(Mutex::new(None));
        let (d2, c2) = (demarree.clone(), contexte.clone());
        let mut d = Demande::new(
            "test",
            label,
            Box::new(move |c: Contexte| {
                d2.fetch_add(1, Ordering::SeqCst);
                *c2.lock().unwrap() = Some((c.annule, c.progres));
                async move { rx.await.unwrap() }.boxed()
            }),
        );
        regler(&mut d);
        let f = tokio::spawn(g.lancer(d));
        (Pilote { fin: Some(tx), demarree, contexte }, f)
    }

    fn etats(g: &Gestionnaire) -> Vec<String> {
        g.liste().iter().map(|t| format!("{}:{}", t.label, t.state)).collect()
    }

    async fn attendre(g: &Gestionnaire, attendu: &[&str]) {
        for _ in 0..200 {
            if etats(g) == attendu {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(etats(g), attendu);
    }

    #[tokio::test]
    async fn tache_terminee_puis_en_echec() {
        let (g, envois, h) = installer(2, Box::new(|_| false));
        let (mut a, fa) = piloter(&g, "A", |d| {
            d.kind = "modpack-install".into();
            d.instance_id = Some("survie".into());
            d.params = json!({ "projectId": "p" });
        });
        assert_eq!(etats(&g), ["A:running"]);
        assert!(g.occupe());
        assert_eq!(g.actuelle().as_deref(), Some("A"));
        a.finir(Ok(json!(42)));
        assert_eq!(fa.await.unwrap().unwrap(), json!(42));
        assert!(!g.occupe());
        assert_eq!(g.actuelle(), None);
        let t = h.0.lock().unwrap()[0].clone();
        assert_eq!(
            (t.kind.as_str(), t.state.as_str(), t.instance_id.as_deref(), t.error),
            ("modpack-install", "done", Some("survie"), None)
        );
        assert_eq!(t.params, json!({ "projectId": "p" }).as_object().cloned());
        assert_eq!(Value::Object(t.progress.unwrap()), json!({ "done": 0, "total": 0 }));
        assert_eq!(messages(&envois, "tasks:changed").last().unwrap(), &json!([]));

        let (mut b, fb) = piloter(&g, "B", |_| {});
        b.finir(Err(Erreur::new("Réseau injoignable")));
        assert_eq!(fb.await.unwrap().unwrap_err().message, "Réseau injoignable");
        let t = h.0.lock().unwrap()[1].clone();
        assert_eq!((t.state.as_str(), t.error.as_deref()), ("failed", Some("Réseau injoignable")));
    }

    #[tokio::test]
    async fn deux_a_la_fois_et_une_par_instance() {
        let (g, _, _) = installer(2, Box::new(|_| false));
        let (mut a, fa) = piloter(&g, "A", |_| {});
        let (mut b, fb) = piloter(&g, "B", |_| {});
        let (mut c, fc) = piloter(&g, "C", |_| {});
        assert_eq!(etats(&g), ["A:running", "B:running", "C:queued"]);
        assert_eq!(c.demarree.load(Ordering::SeqCst), 0);
        b.finir(Ok(Value::Null));
        fb.await.unwrap().unwrap();
        assert_eq!(etats(&g), ["A:running", "C:running"]);
        a.finir(Ok(Value::Null));
        c.finir(Ok(Value::Null));
        fa.await.unwrap().unwrap();
        fc.await.unwrap().unwrap();

        let (mut a, fa) = piloter(&g, "A", |d| d.instance_id = Some("survie".into()));
        let (mut b, fb) = piloter(&g, "B", |d| d.instance_id = Some("survie".into()));
        let (mut c, fc) = piloter(&g, "C", |d| d.instance_id = Some("creatif".into()));
        assert_eq!(etats(&g), ["A:running", "C:running", "B:queued"]);
        a.finir(Ok(Value::Null));
        fa.await.unwrap().unwrap();
        assert_eq!(etats(&g), ["B:running", "C:running"]);
        b.finir(Ok(Value::Null));
        c.finir(Ok(Value::Null));
        fb.await.unwrap().unwrap();
        fc.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn priorites() {
        let (g, _, _) = installer(1, Box::new(|_| false));
        let ordre = Arc::new(Mutex::new(vec![]));
        let (mut premiere, fp) = piloter(&g, "A", |_| {});
        let ajouter = |label: &'static str, p: &'static str| {
            let o = ordre.clone();
            let mut d = Demande::new(
                "x",
                label,
                Box::new(move |_| {
                    async move {
                        o.lock().unwrap().push(label);
                        Ok(Value::Null)
                    }
                    .boxed()
                }),
            );
            d.priority = p;
            tokio::spawn(g.lancer(d))
        };
        let toutes = [ajouter("B", "normal"), ajouter("C", "low"), ajouter("D", "high"), ajouter("E", "normal"), ajouter("F", "high")];
        assert_eq!(etats(&g), ["A:running", "D:queued", "F:queued", "B:queued", "E:queued", "C:queued"]);
        premiere.finir(Ok(Value::Null));
        fp.await.unwrap().unwrap();
        for f in toutes {
            f.await.unwrap().unwrap();
        }
        assert_eq!(*ordre.lock().unwrap(), ["D", "F", "B", "E", "C"]);
    }

    #[tokio::test]
    async fn annulations() {
        let (g, _, h) = installer(1, Box::new(|_| false));
        let (mut a, fa) = piloter(&g, "A", |_| {});
        let (b, fb) = piloter(&g, "B", |d| d.cancellable = true);
        let attente = g.liste()[1].id.clone();
        assert!(g.annuler(Some(&attente)));
        let e = fb.await.unwrap().unwrap_err();
        assert!(e.message.contains('B'), "{}", e.message);
        assert_eq!(b.demarree.load(Ordering::SeqCst), 0);
        let derniere = h.0.lock().unwrap().last().unwrap().clone();
        assert_eq!((derniere.state.as_str(), derniere.started_at), ("cancelled", None));
        assert!(!g.annuler(Some("inconnue")));

        // En cours, sans annulation possible : rien.
        assert!(!g.annuler(Some(&g.liste()[0].id)));
        assert!(!a.annulee());
        a.finir(Ok(Value::Null));
        fa.await.unwrap().unwrap();

        let (mut o, fo) = piloter(&g, "O", |d| d.cancellable = true);
        assert!(g.annuler(None));
        assert!(o.annulee());
        o.finir(Err(Erreur::new("Sauvegarde annulée")));
        assert_eq!(fo.await.unwrap().unwrap_err().message, "Sauvegarde annulée");
        assert_eq!(h.0.lock().unwrap().last().unwrap().state, "cancelled");

        // Annulée trop tard : la tâche a fini quand même.
        let (mut l, fl) = piloter(&g, "L", |d| d.cancellable = true);
        g.annuler(None);
        l.finir(Ok(json!("fini")));
        assert_eq!(fl.await.unwrap().unwrap(), json!("fini"));
        assert_eq!(h.0.lock().unwrap().last().unwrap().state, "done");
    }

    #[tokio::test]
    async fn instance_en_partie_et_tache_immediate() {
        let joue = Arc::new(Mutex::new(Some("survie".to_string())));
        let j = joue.clone();
        let (g, envois, _) = installer(1, Box::new(move |id| j.lock().unwrap().as_deref() == Some(id)));
        let (mut maj, fm) = piloter(&g, "Mise à jour", |d| d.instance_id = Some("survie".into()));
        assert_eq!(etats(&g), ["Mise à jour:queued"]);
        assert!(g.en_cours_sur("survie").is_none());
        *joue.lock().unwrap() = None;
        g.pomper();
        assert_eq!(maj.demarree.load(Ordering::SeqCst), 1);
        maj.finir(Ok(Value::Null));
        fm.await.unwrap().unwrap();

        let (mut longue, fl) = piloter(&g, "Installation", |d| d.instance_id = Some("creatif".into()));
        let (mut prep, fp) = piloter(&g, "Préparation", |d| {
            d.kind = "launch-prepare".into();
            d.instance_id = Some("survie".into());
            d.immediate = true;
            d.cancellable = true;
        });
        assert_eq!(etats(&g), ["Installation:running", "Préparation:running"]);
        assert_eq!(messages(&envois, "task:progress").last().unwrap()["label"], "Installation");
        let (mut sauvegarde, fs) = piloter(&g, "Sauvegarde", |d| d.instance_id = Some("survie".into()));
        assert_eq!(sauvegarde.demarree.load(Ordering::SeqCst), 0);
        assert!(g.en_cours_sur("survie").is_none());
        prep.progres(Etape { done: 3, total: 9, step: Some(2), ..Default::default() });
        assert_eq!(g.liste().iter().find(|t| t.kind == "launch-prepare").unwrap().progress.step, Some(2));
        prep.finir(Err(Erreur::code("Lancement annulé.", "CANCELLED")));
        assert!(fp.await.unwrap().is_err());
        longue.finir(Ok(Value::Null));
        fl.await.unwrap().unwrap();
        assert_eq!(sauvegarde.demarree.load(Ordering::SeqCst), 1);
        sauvegarde.finir(Ok(Value::Null));
        fs.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn progression_et_envois() {
        let (g, envois, _) = installer(2, Box::new(|_| false));
        let (mut a, fa) = piloter(&g, "Sauvegarde des mondes", |d| d.cancellable = true);
        a.progres(Etape { label: Some("Sauvegarde de Monde".into()), done: 1, total: 4, ..Default::default() });
        a.progres(Etape {
            done: 3,
            total: 10,
            done_bytes: Some(1500),
            total_bytes: Some(5000),
            speed: Some(750.0),
            eta: Some(5.0),
            ..Default::default()
        });
        assert_eq!(
            serde_json::to_value(&g.liste()[0].progress).unwrap(),
            json!({ "label": "Sauvegarde des mondes", "done": 3, "total": 10, "doneBytes": 1500, "totalBytes": 5000, "speed": 750.0, "eta": 5.0 })
        );
        a.progres(Etape { done: 4, total: 10, done_bytes: Some(2000), total_bytes: Some(5000), ..Default::default() });
        assert_eq!(
            serde_json::to_value(&g.liste()[0].progress).unwrap(),
            json!({ "label": "Sauvegarde des mondes", "done": 4, "total": 10, "doneBytes": 2000, "totalBytes": 5000 })
        );
        let avant = messages(&envois, "tasks:changed").len();
        a.finir(Ok(Value::Null));
        fa.await.unwrap().unwrap();
        assert_eq!(
            messages(&envois, "task:progress"),
            [
                json!({ "label": "Sauvegarde des mondes", "done": 0, "total": 0, "cancellable": true }),
                json!({ "label": "Sauvegarde de Monde", "done": 1, "total": 4, "cancellable": true }),
                json!({ "label": "Sauvegarde des mondes", "done": 3, "total": 10, "cancellable": true }),
                json!({ "label": "Sauvegarde des mondes", "done": 4, "total": 10, "cancellable": true }),
                Value::Null,
            ]
        );
        // Les trois progressions rapprochées ont donné au plus un envoi groupé, la fin un envoi immédiat.
        assert!(messages(&envois, "tasks:changed").len() <= avant + 2);
        assert_eq!(messages(&envois, "tasks:changed").last().unwrap(), &json!([]));
    }

    #[tokio::test]
    async fn envoi_groupe_de_la_progression() {
        let (g, envois, _) = installer(2, Box::new(|_| false));
        let (mut a, fa) = piloter(&g, "A", |_| {});
        let apres_debut = messages(&envois, "tasks:changed").len();
        for i in 1..=20 {
            a.progres(Etape { done: i, total: 20, ..Default::default() });
        }
        assert_eq!(messages(&envois, "tasks:changed").len(), apres_debut);
        tokio::time::sleep(Duration::from_millis(250)).await;
        let m = messages(&envois, "tasks:changed");
        assert_eq!(m.len(), apres_debut + 1);
        assert_eq!(m.last().unwrap()[0]["progress"], json!({ "label": "A", "done": 20, "total": 20 }));
        a.finir(Ok(Value::Null));
        fa.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn tache_de_fond() {
        let (g, envois, _) = installer(2, Box::new(|_| false));
        let (mut fond, ff) = piloter(&g, "Nettoyage", |d| {
            d.hidden = true;
            d.priority = "low";
        });
        assert!(messages(&envois, "task:progress").is_empty());
        assert!(!g.occupe());
        assert_eq!(g.actuelle(), None);
        assert!(!g.annuler(None));
        assert_eq!(g.liste().iter().map(|t| (t.label.as_str(), t.hidden)).collect::<Vec<_>>(), [("Nettoyage", true)]);
        let (mut longue, fl) = piloter(&g, "Installation", |_| {});
        assert_eq!(
            messages(&envois, "task:progress").last().unwrap(),
            &json!({ "label": "Installation", "done": 0, "total": 0, "cancellable": false })
        );
        fond.finir(Ok(Value::Null));
        longue.finir(Ok(Value::Null));
        ff.await.unwrap().unwrap();
        fl.await.unwrap().unwrap();
        attendre(&g, &[]).await;
        assert_eq!(messages(&envois, "task:progress").last().unwrap(), &Value::Null);
    }

    #[test]
    fn historique_sans_travail_de_fond() {
        struct Lignes(Mutex<Vec<i64>>);
        impl Historique for Lignes {
            fn noter(&self, _: &Tache) {}
            fn recentes(&self, limite: i64) -> Vec<Map<String, Value>> {
                self.0.lock().unwrap().push(limite);
                [
                    json!({ "id": "b", "kind": "world-backup", "label": "Sauvegarde", "instance_id": "survie", "state": "cancelled", "created_at": 2,
                            "started_at": 2, "ended_at": 3, "error": "Annulée", "params": { "folder": "Monde" }, "progress": { "done": 1, "total": 4 }, "hidden": false }),
                    json!({ "id": "n", "kind": "temp-cleanup", "hidden": true }),
                    json!({ "id": "ancien", "kind": "temp-cleanup", "hidden": false }),
                ]
                .into_iter()
                .map(|v| v.as_object().unwrap().clone())
                .collect()
            }
            fn effacer(&self) {}
        }
        let h = Arc::new(Lignes(Mutex::default()));
        let g = Gestionnaire::new(Options { historique: Some(h.clone()), ..Default::default() });
        assert_eq!(
            g.recentes(None),
            [
                json!({ "id": "b", "kind": "world-backup", "label": "Sauvegarde", "instanceId": "survie", "state": "cancelled", "createdAt": 2,
                     "startedAt": 2, "endedAt": 3, "error": "Annulée", "params": { "folder": "Monde" }, "progress": { "done": 1, "total": 4 } })
            ]
        );
        g.recentes(Some(500));
        g.recentes(Some(-3));
        assert_eq!(*h.0.lock().unwrap(), [100, 100, 100]);
        assert!(Gestionnaire::new(Options::default()).recentes(None).is_empty());
        assert_eq!(base36(1_700_000_000_000), "loyw3v28");
    }
}
