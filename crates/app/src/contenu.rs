//! Commandes du contenu (R4) : instances, contenu et Modrinth, ensembles, contrôle des mods, écran titre, modpacks,
//! import, mondes et sauvegardes, stockage, optimisations, pack Performances et conseiller de mémoire. Même
//! enchaînement que les services Electron (services/content.js, backups.js, system.js et les canaux ipc/*.js).
//! Les sélecteurs de fichiers (fond, import de fichiers, .mrpack, export) arrivent avec les écrans (R5) : ces
//! commandes reçoivent déjà le chemin choisi.

use coeur::base::Base;
use coeur::contenu::{Contenu, Installe, chemin_sur, dossier_contenu, loaders_pour};
use coeur::controle_mods::Controle;
use coeur::ecran_titre;
use coeur::erreur::{Erreur, Resultat};
use coeur::gestion_instances as gestion;
use coeur::i18n::{t, tv};
use coeur::jeu::Jeu;
use coeur::mondes;
use coeur::optimisations::Optimisations;
use coeur::partie::Parties;
use coeur::taches::{Contexte, Demande, Etape, Gestionnaire};
use commun::{Instance, Reglages};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

type R<T> = Result<T, String>;
type S<'a> = State<'a, Arc<Services>>;

trait Message<T> {
    fn ou(self) -> R<T>;
}
impl<T> Message<T> for Resultat<T> {
    fn ou(self) -> R<T> {
        self.map_err(|e| e.message)
    }
}

/// Corbeille du système : on peut toujours récupérer ce qui part.
pub fn corbeille(p: &Path) -> Resultat<()> {
    trash::delete(p).map_err(|e| Erreur::new(e.to_string()))
}

pub struct Services {
    pub jeu: Arc<Jeu>,
    pub base: Arc<Base>,
    pub contenu: Contenu,
    pub controle: Controle,
    pub taches: Arc<Gestionnaire>,
    pub parties: Arc<Parties>,
    /// Dossiers trouvés par une recherche d'import → nom du launcher : seuls ceux-là peuvent être importés.
    importables: Mutex<HashMap<PathBuf, String>>,
    /// Version sans FancyMenu, retenue jusqu'à la fermeture : on ne redemande pas à chaque partie.
    sans_menu: Mutex<HashMap<String, String>>,
}

fn verrou<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Pont entre l'annulation d'une tâche et les fonctions du moteur qui lisent un drapeau. La surveillance s'arrête
/// quand le drapeau disparaît (fin du travail).
struct Drapeau(Arc<AtomicBool>, tokio::task::JoinHandle<()>);

impl std::ops::Deref for Drapeau {
    type Target = AtomicBool;
    fn deref(&self) -> &AtomicBool {
        &self.0
    }
}

impl Drop for Drapeau {
    fn drop(&mut self) {
        self.1.abort();
    }
}

fn drapeau(ctx: &Contexte) -> Drapeau {
    let d = Arc::new(AtomicBool::new(false));
    let (a, jeton) = (d.clone(), ctx.annule.clone());
    Drapeau(
        d,
        tokio::spawn(async move {
            jeton.cancelled().await;
            a.store(true, Ordering::SeqCst);
        }),
    )
}

fn etape(label: Option<String>, fait: usize, total: usize) -> Etape {
    Etape { label, done: fait as u64, total: total as u64, ..Etape::default() }
}

fn valeur<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or_default()
}

impl Services {
    pub fn new(jeu: Arc<Jeu>, base: Arc<Base>, taches: Arc<Gestionnaire>, parties: Arc<Parties>) -> Arc<Self> {
        Arc::new(Self {
            contenu: Contenu::new(jeu.clone(), base.clone()),
            jeu,
            base,
            controle: Controle::default(),
            taches,
            parties,
            importables: Mutex::default(),
            sans_menu: Mutex::default(),
        })
    }

    fn racine(&self) -> &Path {
        &self.jeu.dossiers.racine
    }

    fn instance(&self, id: &str) -> R<Instance> {
        coeur::instances::lire(self.racine(), id).ok_or_else(|| t("instances.instance_introuvable"))
    }

    fn dossier_jeu(&self, id: &str) -> PathBuf {
        coeur::instances::dossier(self.racine(), id).join("minecraft")
    }

    fn dossier_sauvegardes(&self, id: &str) -> PathBuf {
        self.jeu.dossiers.backups.join(id)
    }

    fn defauts(&self) -> Reglages {
        coeur::reglages::Magasin::new(&coeur::chemins::donnees()).defauts()
    }

    fn optimisations(&self) -> Optimisations<'_> {
        Optimisations { base: &self.base, racine: self.racine(), maintenant: coeur::base::maintenant }
    }

    /// Refusé tant que l'instance tourne.
    fn pas_en_jeu(&self, id: &str, action: &str) -> R<()> {
        if self.parties.instance_en_jeu().as_deref() == Some(id) {
            return Err(tv("ipc.impossible_de_pendant_que_instance", &[("action", &t(action))]));
        }
        Ok(())
    }

    /// Ni partie ni tâche longue en cours.
    fn pas_occupe(&self, action: &str) -> R<()> {
        if self.parties.en_cours() {
            return Err(tv("ipc.impossible_de_pendant_une_partie", &[("action", &t(action))]));
        }
        match self.taches.actuelle() {
            Some(tache) => Err(tv("ipc.patiente_est_en_cours", &[("task", &tache)])),
            None => Ok(()),
        }
    }

    async fn tache(&self, d: Demande) -> R<Value> {
        self.taches.lancer(d).await.ou()
    }

    /// Après un changement du dossier des mods, l'ensemble actif suit.
    async fn synchroniser(&self, id: &str) {
        if let Ok(i) = self.instance(id) {
            let _ = coeur::ensembles::synchroniser(&self.contenu, self.racine(), &i, &self.dossier_jeu(id)).await;
        }
    }

    /// Mods dont le jar annonce une autre version de Minecraft (d'après le contrôle).
    fn jars_differents(&self, dossier_jeu: &Path, instance: &Instance) -> HashSet<String> {
        let d = self.controle.controler(Some(&self.base), dossier_jeu, instance);
        d.problems.into_iter().filter_map(|p| p.id.strip_prefix("mc:").map(String::from)).collect()
    }

    /// Sauvegarde automatique des mondes (raison : launch, version, loader, modpack), comme tâche prioritaire.
    /// Some({ backupError }) si elle échoue : l'opération demandée n'a alors pas lieu.
    pub async fn sauvegarde_avant(self: &Arc<Self>, instance: &Instance, raison: &str) -> Option<Value> {
        let filtre = mondes::filtre_auto(&instance.settings, raison)?;
        let dj = self.dossier_jeu(&instance.id);
        if !mondes::mondes(&dj).iter().any(filtre) {
            return None;
        }
        let (dossier, garder, raison_t) = (self.dossier_sauvegardes(&instance.id), instance.settings.backup_keep, raison.to_string());
        let mut d = Demande::new(
            "worlds-auto-backup",
            t("ipc.sauvegarde_des_mondes"),
            Box::new(move |ctx| {
                let annule = drapeau(&ctx);
                let progres = ctx.progres;
                tokio::task::spawn_blocking(move || {
                    let mut suivre = |fait, total, monde: &str| {
                        let label =
                            if monde.is_empty() { t("ipc.sauvegarde_des_mondes") } else { tv("ipc.sauvegarde_de", &[("name", monde)]) };
                        progres(etape(Some(label), fait, total));
                    };
                    mondes::sauvegarder_tous(&dj, &dossier, (&raison_t, garder), &corbeille, &filtre, &annule, &mut suivre).map(valeur)
                })
                .map(|r| r.unwrap_or_else(|e| Err(Erreur::new(e.to_string()))))
                .boxed()
            }),
        );
        d.cancellable = true;
        d.instance_id = Some(instance.id.clone());
        d.params = json!({ "reason": raison, "name": instance.name });
        // Avant une partie ou une mise à jour : passe avant les tâches qui attendent.
        d.priority = "high";
        self.tache(d).await.err().map(|e| json!({ "backupError": e }))
    }

    fn ouvrir(&self, app: &tauri::AppHandle, dossier: &Path) -> R<()> {
        std::fs::create_dir_all(dossier).map_err(|e| e.to_string())?;
        app.opener().open_path(dossier.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
    }
}

// ---------- Instances ----------

#[tauri::command]
pub async fn instances_creer(s: S<'_>, donnees: Value) -> R<Instance> {
    gestion::creer(s.racine(), &donnees, &s.defauts()).ou()
}

/// Changer de version ou de loader convertit les mondes sans retour possible : ils sont sauvegardés avant.
#[tauri::command]
pub async fn instances_modifier(s: S<'_>, id: String, patch: Value, options: Option<Value>) -> R<Value> {
    if s.parties.instance_en_jeu().as_deref() == Some(id.as_str()) && patch.get("version").is_some() {
        return Err(t("ipc.impossible_de_changer_de_version"));
    }
    let actuelle = s.instance(&id)?;
    let loader_change = patch.get("loader").is_some_and(|l| {
        l.as_str() != Some(actuelle.loader.as_str())
            || patch.get("loaderVersion").and_then(Value::as_str) != actuelle.loader_version.as_deref()
    });
    let version_change = patch.get("version").and_then(Value::as_str).is_some_and(|v| v != actuelle.version);
    let raison = if version_change {
        Some("version")
    } else if loader_change {
        Some("loader")
    } else {
        None
    };
    let sauter = options.as_ref().and_then(|o| o.get("skipBackup")) == Some(&Value::Bool(true));
    if let Some(r) = raison.filter(|_| !sauter)
        && let Some(echec) = s.sauvegarde_avant(&actuelle, r).await
    {
        return Ok(echec);
    }
    // Mémoire, préréglage Java, priorité, arguments : notés dans l'historique des optimisations (copie d'avant).
    if let Some(r) = patch.get("settings") {
        let suivants = coeur::reglages::nettoyer_instance(r, &actuelle.settings);
        let _ = s.optimisations().reglages_changent(&actuelle, &suivants);
    }
    gestion::modifier(s.racine(), &id, &patch).map(valeur).ou()
}

#[tauri::command]
pub async fn optimisations_liste(s: S<'_>, id: String) -> R<Vec<coeur::optimisations::Ligne>> {
    let i = s.instance(&id)?;
    Ok(s.optimisations().liste(&i.id))
}

#[tauri::command]
pub async fn optimisations_revenir(s: S<'_>, id: String, optimisation: i64) -> R<coeur::optimisations::Retour> {
    let i = s.instance(&id)?;
    s.pas_en_jeu(&i.id, "ipc.revenir_avant_optimisation")?;
    s.optimisations().revenir(&i.id, optimisation, &corbeille).ou()
}

#[tauri::command]
pub async fn instances_dupliquer(s: S<'_>, id: String, nom: String) -> R<Instance> {
    s.pas_en_jeu(&id, "ipc.action_duplicate")?;
    gestion::dupliquer(s.racine(), &id, &nom).ou()
}

/// Fond d'instance depuis une image choisie (le sélecteur arrive avec les écrans).
#[tauri::command]
pub async fn instances_importer_fond(s: S<'_>, id: String, chemin: String) -> R<String> {
    s.instance(&id)?;
    gestion::importer_fond(s.racine(), &id, Path::new(&chemin)).ou()
}

#[tauri::command]
pub async fn instances_nettoyer_fond(s: S<'_>, id: String) -> R<()> {
    gestion::nettoyer_fonds(s.racine(), &id);
    Ok(())
}

/// Suppression = corbeille : on peut toujours récupérer ses mondes.
#[tauri::command]
pub async fn instances_supprimer(s: S<'_>, id: String) -> R<()> {
    s.pas_en_jeu(&id, "ipc.action_delete")?;
    s.instance(&id)?;
    corbeille(&coeur::instances::dossier(s.racine(), &id)).ou()?;
    let magasin = coeur::reglages::Magasin::new(&coeur::chemins::donnees());
    if magasin.interface().selected_id.as_deref() == Some(id.as_str()) {
        magasin.changer_interface(&json!({ "selectedId": null })).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn instances_ouvrir_dossier(app: tauri::AppHandle, s: S<'_>, id: String) -> R<()> {
    s.instance(&id)?;
    s.ouvrir(&app, &s.dossier_jeu(&id))
}

/// Fonds d'instance : fond://localhost/<instance>/<fichier> (http://fond.localhost/… sous Windows), seulement les
/// images « fond-… » du dossier de l'instance.
pub fn image_fond(uri: &str) -> tauri::http::Response<Vec<u8>> {
    let sans = uri.split(['?', '#']).next().unwrap_or("");
    let mut morceaux = sans.trim_end_matches('/').rsplit('/');
    let (nom, id) = (morceaux.next().unwrap_or(""), morceaux.next().unwrap_or(""));
    let fichier = gestion::fichier_fond(&coeur::chemins::racine_jeu(), id, nom);
    let genre = match nom.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        _ => "image/webp",
    };
    match fichier.and_then(|f| std::fs::read(f).ok()) {
        Some(o) => tauri::http::Response::builder()
            .header("Content-Type", genre)
            .header("Access-Control-Allow-Origin", "*")
            .body(o)
            .unwrap_or_default(),
        None => tauri::http::Response::builder().status(404).body(vec![]).unwrap_or_default(),
    }
}

// ---------- Contenu ----------

/// Chaque fichier dit s'il est prévu pour la version de l'instance : versions listées sur Modrinth, ou plage du jar.
#[tauri::command]
pub async fn contenu_lister(s: S<'_>, id: String, genre: String) -> R<Value> {
    let i = s.instance(&id)?;
    let dj = s.dossier_jeu(&id);
    let liste = s.contenu.lister(&dj, &genre, &i, true).await.ou()?;
    let differents = if genre == "mods" { s.jars_differents(&dj, &i) } else { HashSet::new() };
    let mut v = valeur(&liste);
    for (item, e) in v["items"].as_array_mut().into_iter().flatten().zip(&liste.items) {
        let absente = e.game_versions.as_ref().is_some_and(|l| !l.is_empty() && !l.contains(&i.version));
        item["incompatible"] = json!(differents.contains(&e.file) || absente);
    }
    Ok(v)
}

#[tauri::command]
pub async fn contenu_plan_version(s: S<'_>, id: String, cible: String) -> R<Vec<Value>> {
    let i = s.instance(&id)?;
    let dj = s.dossier_jeu(&id);
    let differents = s.jars_differents(&dj, &Instance { version: cible.clone(), ..i.clone() });
    s.contenu.plan_de_version(&dj, &i, &cible, &differents).await.ou()
}

#[tauri::command]
pub async fn contenu_basculer(s: S<'_>, id: String, genre: String, fichier: String) -> R<()> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    s.instance(&id)?;
    s.contenu.basculer(&s.dossier_jeu(&id), &genre, &fichier).ou()?;
    if genre == "mods" {
        s.synchroniser(&id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn contenu_supprimer(s: S<'_>, id: String, genre: String, fichier: String) -> R<()> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    s.instance(&id)?;
    let dossier = dossier_contenu(&s.dossier_jeu(&id), &genre).ou()?;
    corbeille(&chemin_sur(&dossier, &fichier).ou()?).ou()?;
    if genre == "mods" {
        s.synchroniser(&id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn contenu_installer(s: S<'_>, id: String, genre: String, projet: String, version: Option<String>) -> R<Value> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    let i = s.instance(&id)?;
    let dj = s.dossier_jeu(&id);
    let r = s.contenu.installer(&dj, &genre, &i, &projet, version.as_deref().filter(|v| !v.is_empty()), &corbeille).await.ou()?;
    if genre != "mods" {
        return Ok(valeur(r));
    }
    s.synchroniser(&id).await;
    // Le jar peut réclamer plus que ce que sa page Modrinth annonce.
    let i = s.instance(&id)?;
    let extra = coeur::dependances::resoudre(&s.contenu, &s.controle, &dj, &i, &corbeille).await.ok();
    let (plus, manquants): (Vec<Installe>, usize) = extra.map(|e| (e.installed, e.unresolved.len())).unwrap_or_default();
    let mut installes = r.installed;
    installes.extend(plus);
    Ok(json!({ "installed": installes, "missingDependencies": r.missing_dependencies.max(manquants) }))
}

#[tauri::command]
pub async fn contenu_mettre_a_jour(s: S<'_>, id: String, genre: String, fichiers: Option<Vec<String>>) -> R<Vec<Installe>> {
    s.pas_en_jeu(&id, "ipc.mettre_jour_son_contenu")?;
    let i = s.instance(&id)?;
    let r = s.contenu.mettre_a_jour(&s.dossier_jeu(&id), &genre, &i, fichiers.as_deref(), &corbeille).await.ou()?;
    if genre == "mods" {
        s.synchroniser(&id).await;
    }
    Ok(r)
}

#[tauri::command]
pub async fn contenu_importer(s: S<'_>, id: String, genre: String, chemins: Vec<String>) -> R<Vec<String>> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    s.instance(&id)?;
    let chemins: Vec<PathBuf> = chemins.into_iter().map(PathBuf::from).collect();
    let r = s.contenu.importer(&s.dossier_jeu(&id), &genre, &chemins).ou()?;
    if genre == "mods" {
        s.synchroniser(&id).await;
    }
    Ok(r)
}

#[tauri::command]
pub async fn contenu_ouvrir_dossier(app: tauri::AppHandle, s: S<'_>, id: String, genre: String) -> R<()> {
    s.instance(&id)?;
    s.ouvrir(&app, &dossier_contenu(&s.dossier_jeu(&id), &genre).ou()?)
}

// ---------- Ensembles de mods et contrôle ----------

#[tauri::command]
pub async fn ensembles_creer(s: S<'_>, id: String, nom: String) -> R<Value> {
    let i = s.instance(&id)?;
    coeur::ensembles::creer(&s.contenu, s.racine(), &i, &s.dossier_jeu(&id), &nom).await.ou()
}

#[tauri::command]
pub async fn ensembles_renommer(s: S<'_>, id: String, ensemble: String, nom: String) -> R<()> {
    let i = s.instance(&id)?;
    coeur::ensembles::renommer(s.racine(), &i, &ensemble, &nom).ou()
}

#[tauri::command]
pub async fn ensembles_supprimer(s: S<'_>, id: String, ensemble: String) -> R<()> {
    let i = s.instance(&id)?;
    coeur::ensembles::supprimer(s.racine(), &i, &ensemble).ou()
}

#[tauri::command]
pub async fn ensembles_appliquer(s: S<'_>, id: String, ensemble: Option<String>) -> R<coeur::ensembles::Application> {
    s.pas_en_jeu(&id, "ipc.changer_ensemble_de_mods")?;
    let i = s.instance(&id)?;
    coeur::ensembles::appliquer(&s.contenu, s.racine(), &i, &s.dossier_jeu(&id), ensemble.as_deref()).await.ou()
}

#[tauri::command]
pub async fn controle_mods(s: S<'_>, id: String) -> R<coeur::controle_mods::Diagnostic> {
    let i = s.instance(&id)?;
    Ok(s.controle.controler(Some(&s.base), &s.dossier_jeu(&id), &i))
}

/// Installe ce que les mods de l'instance réclament, d'où qu'ils viennent.
#[tauri::command]
pub async fn controle_resoudre(s: S<'_>, id: String) -> R<coeur::dependances::Resolution> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    let i = s.instance(&id)?;
    let r = coeur::dependances::resoudre(&s.contenu, &s.controle, &s.dossier_jeu(&id), &i, &corbeille).await.ou()?;
    if !r.installed.is_empty() {
        s.synchroniser(&id).await;
    }
    Ok(r)
}

// ---------- Écran titre (menu Cristal) ----------

async fn etat_menu(s: &Services, id: &str) -> R<ecran_titre::Etat> {
    let i = s.instance(id)?;
    let m = s.contenu.modrinth();
    let versions = async { m.versions(ecran_titre::FANCYMENU, &loaders_pour("mods", &i), Some(&i.version)).await.map(|l| l.len()) };
    Ok(ecran_titre::etat(&s.dossier_jeu(id), &i, versions).await)
}

async fn appliquer_menu(s: &Services, id: &str, options: Option<Value>, avant: &ecran_titre::Etat) -> R<()> {
    let dj = s.dossier_jeu(id);
    if !avant.installed {
        let i = s.instance(id)?;
        s.contenu.installer(&dj, "mods", &i, ecran_titre::FANCYMENU, None, &corbeille).await.ou()?;
        s.synchroniser(id).await;
    }
    let i = gestion::modifier(s.racine(), id, &json!({ "titleMenu": options.unwrap_or_else(|| json!({})) })).ou()?;
    ecran_titre::rafraichir(&dj, &i, None, false).ou()
}

#[tauri::command]
pub async fn menu_titre_etat(s: S<'_>, id: String) -> R<ecran_titre::Etat> {
    etat_menu(&s, &id).await
}

#[tauri::command]
pub async fn menu_titre_appliquer(s: S<'_>, id: String, options: Option<Value>) -> R<ecran_titre::Etat> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    let avant = etat_menu(&s, &id).await?;
    appliquer_menu(&s, &id, options, &avant).await?;
    etat_menu(&s, &id).await
}

/// Avant chaque lancement : une instance moddée jamais réglée reçoit le menu Cristal.
#[tauri::command]
pub async fn menu_titre_auto(s: S<'_>, id: String, options: Option<Value>) -> R<Value> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    let i = s.instance(&id)?;
    let cle = format!("{}/{}", i.version, i.loader);
    if !ecran_titre::voulu_auto(&i) || verrou(&s.sans_menu).get(&i.id) == Some(&cle) {
        return Ok(json!({ "added": false }));
    }
    let avant = etat_menu(&s, &id).await?;
    if avant.available == Some(false) {
        verrou(&s.sans_menu).insert(i.id.clone(), cle);
    }
    // Mod connu pour planter avec FancyMenu, ou Modrinth injoignable : on réessaiera au prochain lancement.
    if avant.available != Some(true) || !avant.conflicts.is_empty() {
        return Ok(json!({ "added": false }));
    }
    appliquer_menu(&s, &id, options, &avant).await?;
    Ok(json!({ "added": true, "installed": !avant.installed }))
}

#[tauri::command]
pub async fn menu_titre_retirer(s: S<'_>, id: String) -> R<ecran_titre::Etat> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    s.instance(&id)?;
    ecran_titre::retirer(&s.dossier_jeu(&id)).ou()?;
    gestion::modifier(s.racine(), &id, &json!({ "titleMenu": null })).ou()?;
    etat_menu(&s, &id).await
}

// ---------- Modrinth ----------

#[tauri::command]
pub async fn modrinth_rechercher(s: S<'_>, params: Value) -> R<Value> {
    let texte = |c: &str| params.get(c).and_then(Value::as_str).unwrap_or("").to_string();
    let genre = texte("kind");
    let base = coeur::modrinth::Recherche {
        query: texte("query"),
        sort: texte("sort"),
        offset: params.get("offset").and_then(Value::as_u64).unwrap_or(0) as u32,
        ..Default::default()
    };
    let m = s.contenu.modrinth();
    // Les modpacks créent une nouvelle instance : pas de filtre sur l'instance sélectionnée.
    let r = if genre == "modpacks" {
        coeur::modrinth::Recherche { project_type: "modpack".into(), ..base }
    } else {
        let i = s.instance(&texte("instanceId"))?;
        coeur::modrinth::Recherche {
            project_type: coeur::contenu::genre(&genre).ou()?.projet.into(),
            game_version: Some(i.version.clone()),
            loaders: loaders_pour(&genre, &i),
            ..base
        }
    };
    m.rechercher(&r).await.ou()
}

#[tauri::command]
pub async fn modrinth_projet(s: S<'_>, projet: String) -> R<Value> {
    s.contenu.modrinth().projet(&projet).await.ou()
}

#[tauri::command]
pub async fn modrinth_versions(s: S<'_>, projet: String, instance: Option<String>, genre: String) -> R<Vec<coeur::modrinth::Version>> {
    let m = s.contenu.modrinth();
    if genre == "modpacks" {
        return m.versions(&projet, &[], None).await.ou();
    }
    let i = s.instance(instance.as_deref().unwrap_or(""))?;
    coeur::contenu::genre(&genre).ou()?;
    m.versions(&projet, &loaders_pour(&genre, &i), Some(&i.version)).await.ou()
}

// ---------- Modpacks ----------

fn suivi(progres: coeur::taches::Progres) -> coeur::modpacks::Suivi {
    Some(Arc::new(move |p: coeur::telechargement::Progression| {
        progres(Etape {
            done: p.fait as u64,
            total: p.total as u64,
            done_bytes: Some(p.octets_faits),
            total_bytes: Some(p.octets_total),
            speed: p.vitesse,
            eta: p.reste.map(|r| r as f64),
            ..Etape::default()
        })
    }))
}

async fn installer_octets(
    s: &Arc<Services>,
    label: String,
    octets: Vec<u8>,
    source: Option<Value>,
    genre: &str,
    params: Value,
) -> R<Value> {
    let (jeu, defauts) = (s.jeu.clone(), s.defauts());
    let mut d = Demande::new(
        genre,
        label,
        Box::new(move |ctx| {
            async move {
                let journal = |m: &str| coeur::journal::info(m);
                let i = coeur::modpacks::installer_pack(
                    &jeu,
                    octets,
                    &defauts,
                    source.as_ref(),
                    Some(ctx.annule),
                    suivi(ctx.progres),
                    &journal,
                )
                .await?;
                Ok(valeur(i))
            }
            .boxed()
        }),
    );
    d.params = params;
    s.tache(d).await
}

#[tauri::command]
pub async fn modpacks_installer(s: S<'_>, projet: String, version: Option<String>, meta: Option<Value>) -> R<Value> {
    let choisie = match version.filter(|v| !v.is_empty()) {
        Some(v) => v,
        None => s
            .contenu
            .modrinth()
            .versions(&projet, &[], None)
            .await
            .ou()?
            .first()
            .map(|v| v.id.clone())
            .ok_or_else(|| t("ipc.ce_modpack_aucune_version_telechargeable"))?,
    };
    let (octets, _) = coeur::modpacks::telecharger_pack(&s.jeu, &choisie, None).await.ou()?;
    let meta = meta.unwrap_or_default();
    let titre = meta.get("title").and_then(Value::as_str).filter(|t| !t.is_empty());
    let source = json!({ "projectId": projet, "versionId": choisie, "title": titre, "icon": meta.get("icon").and_then(Value::as_str).filter(|t| !t.is_empty()) });
    let label = tv("ipc.installation_de", &[("title", titre.unwrap_or("modpack"))]);
    installer_octets(&s, label, octets, Some(source.clone()), "modpack-install", source).await
}

/// .mrpack choisi par le joueur (le sélecteur arrive avec les écrans).
#[tauri::command]
pub async fn modpacks_importer(s: S<'_>, chemin: String) -> R<Value> {
    let octets = std::fs::read(&chemin).map_err(|e| e.to_string())?;
    let nom = Path::new(&chemin).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    installer_octets(&s, tv("ipc.import_de", &[("filePaths", &nom)]), octets, None, "modpack-import", json!({ "file": nom })).await
}

#[tauri::command]
pub async fn modpacks_verifier(s: S<'_>, id: String) -> R<Option<Value>> {
    let i = s.instance(&id)?;
    coeur::modpacks::verifier_mise_a_jour(&s.jeu, &i).await.ou()
}

#[tauri::command]
pub async fn modpacks_mettre_a_jour(s: S<'_>, id: String, version: String, options: Option<Value>) -> R<Value> {
    s.pas_en_jeu(&id, "ipc.mettre_jour_le_modpack")?;
    let i = s.instance(&id)?;
    if options.as_ref().and_then(|o| o.get("skipBackup")) != Some(&Value::Bool(true))
        && let Some(echec) = s.sauvegarde_avant(&i, "modpack").await
    {
        return Ok(echec);
    }
    let (octets, _) = coeur::modpacks::telecharger_pack(&s.jeu, &version, None).await.ou()?;
    let (jeu, instance, v) = (s.jeu.clone(), i.clone(), version.clone());
    let mut d = Demande::new(
        "modpack-update",
        tv("ipc.mise_jour_de", &[("name", &i.name)]),
        Box::new(move |ctx| {
            async move {
                let source = json!({ "versionId": v });
                let r = coeur::modpacks::mettre_a_jour_pack(
                    &jeu,
                    &instance,
                    octets,
                    Some(&source),
                    &corbeille,
                    Some(ctx.annule),
                    suivi(ctx.progres),
                )
                .await?;
                Ok(valeur(r))
            }
            .boxed()
        }),
    );
    d.instance_id = Some(i.id.clone());
    d.params = json!({ "versionId": version, "name": i.name });
    s.tache(d).await
}

/// Export en .mrpack vers le fichier choisi (le sélecteur arrive avec les écrans).
#[tauri::command]
pub async fn instances_exporter(s: S<'_>, id: String, options: Option<Value>, chemin: String) -> R<Value> {
    let i = s.instance(&id)?;
    let o = options.unwrap_or_default();
    let texte = |c: &str| o.get(c).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let nom = Some(texte("name")).filter(|n| !n.is_empty()).unwrap_or_else(|| i.name.clone());
    let version = Some(texte("version")).filter(|n| !n.is_empty()).unwrap_or_else(|| "1.0.0".into());
    let pack = coeur::modpacks::exporter_pack(&s.jeu, &i, &s.dossier_jeu(&id), &nom, &version, &texte("summary")).await.ou()?;
    std::fs::write(&chemin, &pack.octets).map_err(|e| e.to_string())?;
    Ok(json!({ "file": chemin, "referenced": pack.referenced, "embedded": pack.embedded, "size": pack.octets.len() }))
}

// ---------- Import depuis d'autres launchers ----------

/// Dossier d'instances par défaut, ou celui choisi par le joueur. Seuls les dossiers trouvés ici seront importables.
#[tauri::command]
pub async fn import_analyser(s: S<'_>, dossier: Option<String>) -> R<Value> {
    let d = dossier.map(PathBuf::from).unwrap_or_else(|| coeur::import::dossier_par_defaut(&coeur::import::racines_import()));
    let a = coeur::import::analyser(&d);
    let deja: HashSet<String> = coeur::instances::lister(s.racine())
        .into_iter()
        .filter_map(|i| i.imported_from.and_then(|o| o.get("path").and_then(Value::as_str).map(String::from)))
        .collect();
    let mut v = valeur(&a);
    let launcher = a.launcher.clone().unwrap_or_default();
    for (item, src) in v["instances"].as_array_mut().into_iter().flatten().zip(&a.instances) {
        verrou(&s.importables).insert(src.path.clone(), launcher.clone());
        item["imported"] = json!(deja.contains(&*src.path.to_string_lossy()));
    }
    Ok(v)
}

#[tauri::command]
pub async fn import_instance(s: S<'_>, dossier: String) -> R<Value> {
    let source = PathBuf::from(&dossier);
    let launcher = verrou(&s.importables).get(&source).cloned().ok_or_else(|| t("ipc.instance_inconnue_relance_la_recherche"))?;
    let nom = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (jeu, defauts) = (s.jeu.clone(), s.defauts());
    let mut d = Demande::new(
        "instance-import",
        tv("ipc.import_de_2", &[("source", &nom)]),
        Box::new(move |ctx| {
            async move {
                let annule = drapeau(&ctx);
                let progres = ctx.progres;
                let suivre = move |fait, total| progres(etape(None, fait, total));
                coeur::import::importer(&jeu, &source, &defauts, &suivre, &annule).await.map(valeur)
            }
            .boxed()
        }),
    );
    d.params = json!({ "launcher": launcher, "source": nom });
    s.tache(d).await
}

// ---------- Mondes et sauvegardes ----------

#[tauri::command]
pub async fn mondes_liste(s: S<'_>, id: String) -> R<Value> {
    let i = s.instance(&id)?;
    // Ordre de sortie des versions : repère un monde enregistré par une version plus récente que l'instance.
    let sorties: HashMap<String, String> = match s.jeu.manifeste(false).await {
        Ok(m) => m["versions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| Some((v["id"].as_str()?.to_string(), v["releaseTime"].as_str()?.to_string())))
            .collect(),
        Err(_) => HashMap::new(),
    };
    let (dj, sv) = (s.dossier_jeu(&id), s.dossier_sauvegardes(&i.id));
    let (liste, sauvegardes) =
        tokio::task::spawn_blocking(move || (mondes::mondes_et_tailles(&dj), mondes::sauvegardes(&sv))).await.map_err(|e| e.to_string())?;
    let mienne = sorties.get(&i.version);
    let mondes: Vec<Value> = liste
        .into_iter()
        .map(|m| {
            let plus_recent = mienne.is_some_and(|a| m.version.as_ref().and_then(|v| sorties.get(v)).is_some_and(|b| b > a));
            let mut v = valeur(&m);
            v["newer"] = json!(plus_recent);
            v
        })
        .collect();
    Ok(json!({ "worlds": mondes, "backups": sauvegardes }))
}

#[tauri::command]
pub async fn mondes_sauvegarder(s: S<'_>, id: String, monde: String) -> R<Value> {
    let i = s.instance(&id)?;
    s.pas_en_jeu(&i.id, "ipc.sauvegarder_un_monde")?;
    let (dj, sv, m) = (s.dossier_jeu(&id), s.dossier_sauvegardes(&i.id), monde.clone());
    let mut d = Demande::new(
        "world-backup",
        tv("ipc.sauvegarde_de", &[("name", &monde)]),
        Box::new(move |ctx| {
            let annule = drapeau(&ctx);
            let progres = ctx.progres;
            tokio::task::spawn_blocking(move || {
                mondes::sauvegarder(&dj, &m, &sv, &annule, &mut |f, t| progres(etape(None, f, t))).map(valeur)
            })
            .map(|r| r.unwrap_or_else(|e| Err(Erreur::new(e.to_string()))))
            .boxed()
        }),
    );
    d.cancellable = true;
    d.instance_id = Some(i.id.clone());
    d.params = json!({ "folder": monde, "name": i.name });
    s.tache(d).await
}

#[tauri::command]
pub async fn mondes_restaurer(s: S<'_>, id: String, fichier: String, mode: String) -> R<Value> {
    let i = s.instance(&id)?;
    s.pas_en_jeu(&i.id, "ipc.restaurer_un_monde")?;
    let archive = mondes::fichier_sauvegarde(&s.dossier_sauvegardes(&i.id), &fichier).ou()?;
    let dj = s.dossier_jeu(&id);
    let mut d = Demande::new(
        "world-restore",
        tv("ipc.restauration_de", &[("name", &fichier)]),
        Box::new(move |ctx| {
            let annule = drapeau(&ctx);
            let progres = ctx.progres;
            tokio::task::spawn_blocking(move || {
                mondes::restaurer(&archive, &dj, mode == "replace", &corbeille, &annule, &mut |f, t| progres(etape(None, f, t))).map(valeur)
            })
            .map(|r| r.unwrap_or_else(|e| Err(Erreur::new(e.to_string()))))
            .boxed()
        }),
    );
    d.cancellable = true;
    d.instance_id = Some(i.id.clone());
    d.params = json!({ "file": fichier, "name": i.name });
    s.tache(d).await
}

#[tauri::command]
pub async fn mondes_supprimer(s: S<'_>, id: String, monde: String) -> R<()> {
    s.pas_en_jeu(&id, "ipc.supprimer_un_monde")?;
    s.instance(&id)?;
    mondes::supprimer_monde(&s.dossier_jeu(&id), &monde, &corbeille).ou()
}

#[tauri::command]
pub async fn mondes_supprimer_sauvegarde(s: S<'_>, id: String, fichier: String) -> R<()> {
    let i = s.instance(&id)?;
    mondes::supprimer_sauvegarde(&s.dossier_sauvegardes(&i.id), &fichier, &corbeille).ou()
}

#[tauri::command]
pub async fn mondes_ouvrir_dossier(app: tauri::AppHandle, s: S<'_>, id: String, monde: Option<String>) -> R<()> {
    s.instance(&id)?;
    let dj = s.dossier_jeu(&id);
    let dossier = match monde.filter(|m| !m.is_empty()) {
        Some(m) => mondes::dossier_monde(&dj, &m).ou()?,
        None => mondes::saves(&dj),
    };
    s.ouvrir(&app, &dossier)
}

// ---------- Espace disque ----------

#[tauri::command]
pub async fn stockage_utilisation(s: S<'_>) -> R<coeur::stockage::Utilisation> {
    let d = s.jeu.clone();
    tokio::task::spawn_blocking(move || coeur::stockage::utilisation(&d.dossiers)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stockage_plan(s: S<'_>) -> R<Vec<coeur::stockage::Categorie>> {
    let jeu = s.jeu.clone();
    let instances = coeur::instances::lister(s.racine());
    tokio::task::spawn_blocking(move || coeur::stockage::plan(&jeu, &instances)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stockage_nettoyer(s: S<'_>, ids: Vec<String>) -> R<coeur::stockage::Nettoyage> {
    s.pas_occupe("ipc.liberer_de_espace")?;
    let jeu = s.jeu.clone();
    let instances = coeur::instances::lister(s.racine());
    tokio::task::spawn_blocking(move || coeur::stockage::nettoyer(&jeu, &instances, &ids)).await.map_err(|e| e.to_string())
}

// ---------- Performances ----------

fn reglages_essai(s: &Services, instance: Option<&Instance>, reglages: Option<Value>) -> Reglages {
    let base = instance.map(|i| i.settings.clone()).unwrap_or_else(|| s.defauts());
    coeur::reglages::nettoyer_instance(&reglages.unwrap_or_default(), &base)
}

fn instance_option(s: &Services, id: Option<String>) -> R<Option<Instance>> {
    id.filter(|i| !i.is_empty()).map(|i| s.instance(&i)).transpose()
}

/// Conseil de mémoire : charge de l'instance (mods, shaders, ZGC) et composants du PC.
async fn conseil_ram(s: &Services, instance: Option<&Instance>, zgc: bool, mods: u64) -> Value {
    let pc = coeur::materiel::materiel();
    let shaders = match instance {
        Some(i) => coeur::pack::shaders_actifs(&s.contenu, &s.dossier_jeu(&i.id), i).await.unwrap_or(0),
        None => 0,
    };
    let guide = coeur::performances::guide_ram(&coeur::performances::Besoin {
        loader: instance.map_or("vanilla", |i| i.loader.as_str()),
        version: instance.map_or("", |i| i.version.as_str()),
        mods: mods as u32,
        shaders: shaders as u32,
        zgc,
        total_go: pc.total_gb,
        integree: pc.integrated,
    });
    let mut v = valeur(guide);
    v["mods"] = json!(mods);
    v["shaders"] = json!(shaders);
    v["pc"] = json!({ "summary": pc.summary, "detail": pc.detail });
    v
}

async fn compte_pack(s: &Services, instance: Option<&Instance>) -> Value {
    match instance {
        Some(i) => coeur::pack::compte(&s.contenu, &s.dossier_jeu(&i.id), i).await.unwrap_or_else(|_| json!({ "installed": 0, "mods": 0 })),
        None => json!({ "installed": 0, "mods": 0 }),
    }
}

#[tauri::command]
pub async fn perf_guide_ram(s: S<'_>, id: Option<String>, reglages: Option<Value>) -> R<Value> {
    let i = instance_option(&s, id)?;
    let r = reglages_essai(&s, i.as_ref(), reglages);
    let mods = compte_pack(&s, i.as_ref()).await["mods"].as_u64().unwrap_or(0);
    Ok(conseil_ram(&s, i.as_ref(), r.jvm_preset == "zgc", mods).await)
}

/// Arguments Java et conseil de mémoire tels qu'ils seraient avec ces réglages.
#[tauri::command]
pub async fn perf_apercu(s: S<'_>, id: Option<String>, reglages: Option<Value>) -> R<Value> {
    let i = instance_option(&s, id)?;
    let r = reglages_essai(&s, i.as_ref(), reglages);
    let java = match &i {
        Some(i) => s.jeu.details_version(&i.version).await.ok().map(|d| d.java as u32),
        None => None,
    };
    let cpus = coeur::performances::coeurs_logiques();
    let args = coeur::performances::arguments_jvm(&r.jvm_preset, java.unwrap_or(21), r.ram, &r.jvm_args, cpus);
    let compte = compte_pack(&s, i.as_ref()).await;
    let mods = compte["mods"].as_u64().unwrap_or(0);
    let conseil = conseil_ram(&s, i.as_ref(), r.jvm_preset == "zgc" && args.gc == "zgc", mods).await;
    Ok(json!({
        "javaMajor": java,
        "cpus": cpus,
        "gc": args.gc,
        "userGc": coeur::performances::choisi_par_l_utilisateur(&r.jvm_args),
        "args": args.args,
        "ram": if i.is_some() { conseil["ideal"].clone() } else { Value::Null },
        "pc": conseil["pc"]["summary"],
        "mods": mods,
        "packInstalled": compte["installed"],
    }))
}

#[tauri::command]
pub async fn perf_pack(s: S<'_>, id: String) -> R<Value> {
    let i = s.instance(&id)?;
    coeur::pack::etat(&s.contenu, &s.dossier_jeu(&id), &i).await.ou()
}

#[tauri::command]
pub async fn perf_installer_pack(s: S<'_>, id: String, slugs: Vec<String>, options: Option<Value>) -> R<Value> {
    s.pas_en_jeu(&id, "ipc.modifier_son_contenu")?;
    let mut i = s.instance(&id)?;
    // Instance vanilla : passage en Fabric (mondes et réglages gardés), comme « Modifier › Loader ».
    let mut fabric = None;
    if i.loader == "vanilla" {
        if options.as_ref().and_then(|o| o.get("convert")) != Some(&Value::Bool(true)) {
            return Err(t("ipc.cette_instance_est_vanilla_il"));
        }
        let loaders = s.jeu.loaders_disponibles(&i.version).await;
        let v = loaders.get("fabric").and_then(|f| f["recommended"].as_str()).map(String::from);
        fabric = Some(v.ok_or_else(|| tv("ipc.fabric_existe_pas_pour_minecraft", &[("version", &i.version)]))?);
    }
    // Historique des optimisations : copie d'avant le pack (et d'avant le passage en Fabric).
    let note =
        s.optimisations().noter(&i, "perf-pack", Some(&json!({ "count": slugs.len(), "converted": fabric.is_some() }))).ok().flatten();
    if let Some(v) = &fabric {
        i = gestion::modifier(s.racine(), &i.id, &json!({ "loader": "fabric", "loaderVersion": v })).ou()?;
    }
    let services = Arc::clone(&s);
    let (instance, liste) = (i.clone(), slugs.clone());
    let mut d = Demande::new(
        "perf-pack",
        t("ipc.pack_performances"),
        Box::new(move |ctx| {
            async move {
                let progres = ctx.progres;
                let suivre = move |f, t| progres(etape(None, f, t));
                let dj = services.dossier_jeu(&instance.id);
                Ok(valeur(coeur::pack::installer(&services.contenu, &dj, &instance, &liste, &corbeille, &suivre).await))
            }
            .boxed()
        }),
    );
    d.instance_id = Some(i.id.clone());
    d.params = json!({ "slugs": slugs, "name": i.name });
    let mut r = s.tache(d).await?;
    let fichiers: Vec<String> =
        r["installed"].as_array().into_iter().flatten().filter_map(|m| m["file"].as_str()).map(|f| format!("mods/{f}")).collect();
    s.optimisations().ajoutes(note, &fichiers);
    if !fichiers.is_empty() {
        s.synchroniser(&i.id).await;
    }
    r["instance"] = valeur(s.instance(&i.id)?);
    Ok(r)
}

/// Mémoire du PC (totale et libre), en Go.
#[tauri::command]
pub fn systeme_memoire() -> Value {
    let go = |o: u64| o as f64 / 1024f64.powi(3);
    json!({ "totalGb": go(coeur::mesures::memoire_totale()), "freeGb": go(coeur::mesures::memoire_libre()) })
}
