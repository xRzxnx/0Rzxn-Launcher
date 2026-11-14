//! Préparation et lancement d'une partie, comme core/launch.js : chaque étape est annoncée pour la barre de progression.

use crate::arguments::{self, Demande as DemandeArgs, QuickPlay, Variables};
use crate::comptes::CompteJeu;
use crate::erreur::{Erreur, Resultat};
use crate::i18n::{go, t, tv};
use crate::installation::{bibliotheques, extraire_natives};
use crate::java::{JAVA_32_MAX_GO, commande, rosetta_installe, rosetta_necessaire, sonder_en_cache};
use crate::jeu::Jeu;
use crate::journal::censurer;
use crate::loaders::{self, Demande as DemandeLoader};
use crate::mesures;
use crate::regles::Systeme;
use crate::sortie_jeu::{LecteurSortie, LigneJeu, horloge};
use crate::telechargement::Progression;
use commun::{Instance, loader_name};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

pub const ETAPES: [&str; 9] = ["account", "components", "files", "java", "loader", "javaCheck", "memory", "natives", "launch"];
const NOM_LAUNCHER: &str = "0Rzxn_Launcher";

#[derive(Debug, Clone, PartialEq)]
pub enum Evenement {
    /// Étape en cours (index dans ETAPES) ; `octets` pendant un téléchargement.
    Progres {
        etape: usize,
        fait: u64,
        total: u64,
        octets: Option<Progression>,
    },
    Journal(LigneJeu),
    LoaderInstalle(String),
    /// Tout est prêt (vérification seule, sans lancer le jeu).
    Pret,
    Demarre {
        pid: u32,
    },
    /// Échec avant le démarrage du jeu (code : JAVA_32_BIT, ROSETTA_MISSING…).
    Echec {
        message: String,
        annule: bool,
        code: Option<&'static str>,
    },
    Fin {
        code: Option<i32>,
        plante: bool,
        minutes: u64,
    },
}

pub type Rappel = Arc<dyn Fn(Evenement) + Send + Sync>;
/// Compte demandé à l'étape « Compte » (renouvellement de la session Microsoft), avec de quoi écrire dans la console.
pub type DemandeCompte = Box<dyn FnOnce(Arc<dyn Fn(&str) + Send + Sync>) -> BoxFuture<'static, Resultat<CompteJeu>> + Send>;

pub struct Session {
    pub jeu: Arc<Jeu>,
    pub instance: Instance,
    pub dossier_instance: PathBuf,
    pub compte: DemandeCompte,
    pub version_launcher: String,
    pub verifier: bool,
    pub preparer_seulement: bool,
    pub quick_play: Option<QuickPlay>,
    /// Avant le jeu : annule la préparation ; pendant la partie : arrête le jeu.
    pub arret: CancellationToken,
    pub rappel: Rappel,
}

/// Fichier où le jeu note le dernier monde ou serveur rejoint (dans le dossier de l'instance, pas celui du jeu).
pub fn fichier_quick_play(dossier_instance: &Path) -> PathBuf {
    dossier_instance.join("quickplay.json")
}

/// Met « onboardAccessibility » à false dans options.txt (créé si besoin). Renvoie true si quelque chose a changé.
pub fn passer_accessibilite(dossier_jeu: &Path) -> std::io::Result<bool> {
    let f = dossier_jeu.join("options.txt");
    let texte = std::fs::read_to_string(&f).unwrap_or_default();
    if texte.lines().any(|l| l.trim_end() == "onboardAccessibility:false") {
        return Ok(false);
    }
    let suite = if texte.lines().any(|l| l.starts_with("onboardAccessibility:")) {
        texte
            .split_inclusive('\n')
            .map(|l| {
                if l.starts_with("onboardAccessibility:") {
                    format!("onboardAccessibility:false{}", if l.ends_with('\n') { "\n" } else { "" })
                } else {
                    l.into()
                }
            })
            .collect()
    } else {
        format!("{texte}{}onboardAccessibility:false\n", if !texte.is_empty() && !texte.ends_with('\n') { "\n" } else { "" })
    };
    std::fs::create_dir_all(dossier_jeu)?;
    std::fs::write(f, suite)?;
    Ok(true)
}

fn secondes(s: f64) -> String {
    let t = format!("{s:.1}");
    if crate::i18n::langue() == "en" { t } else { t.replace('.', ",") }
}

struct Contexte {
    rappel: Rappel,
    secrets: Arc<Mutex<Vec<String>>>,
}

impl Contexte {
    fn journal(&self, msg: &str, tag: &str) {
        let s = self.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
        (self.rappel)(Evenement::Journal(LigneJeu::new(horloge(), tag, censurer(msg, s.iter().map(String::as_str)))));
    }
    fn log(&self, msg: &str) {
        self.journal(msg, "LAUNCHER");
    }
    fn progres(&self, etape: usize) {
        (self.rappel)(Evenement::Progres { etape, fait: 0, total: 0, octets: None });
    }
    fn suivi(&self, etape: usize) -> Arc<dyn Fn(Progression) + Send + Sync> {
        let r = self.rappel.clone();
        Arc::new(move |p: Progression| r(Evenement::Progres { etape, fait: p.fait as u64, total: p.total as u64, octets: Some(p) }))
    }
}

fn verifier_arret(arret: &CancellationToken) -> Resultat<()> {
    if arret.is_cancelled() { Err(Erreur::code(t("launch.lancement_annule"), "CANCELLED")) } else { Ok(()) }
}

/// Prépare puis lance la partie ; tout passe par `rappel`, jusqu'à Pret, Echec ou Fin.
pub async fn lancer(s: Session) {
    let ctx = Contexte { rappel: s.rappel.clone(), secrets: Arc::default() };
    let arret = s.arret.clone();
    let rappel = s.rappel.clone();
    match preparer(s, &ctx).await {
        Ok(None) => rappel(Evenement::Pret),
        Ok(Some(partie)) => jouer(partie, &ctx, &arret).await,
        Err(e) => {
            let annule = arret.is_cancelled();
            if !annule {
                ctx.journal(&tv("launch.echec", &[("message", &e.message)]), "LAUNCHER/ERROR");
            }
            let message = if annule { t("launch.lancement_annule") } else { e.message };
            rappel(Evenement::Echec { message, annule, code: if annule { None } else { e.code.filter(|c| *c != "IO") } });
        }
    }
}

struct Partie {
    java: PathBuf,
    args: Vec<String>,
    dossier_jeu: PathBuf,
    priorite: String,
}

async fn preparer(s: Session, ctx: &Contexte) -> Resultat<Option<Partie>> {
    let Session { jeu, instance, dossier_instance, compte, version_launcher, verifier, preparer_seulement, quick_play, arret, .. } = s;
    let reglages = &instance.settings;
    let sys = Systeme::actuel();
    let dossier_jeu = dossier_instance.join("minecraft");
    let annule = Some(arret.clone());

    // 1. Compte
    ctx.progres(0);
    let r = ctx.rappel.clone();
    let secrets = ctx.secrets.clone();
    let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |m: &str| {
        let s = secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
        r(Evenement::Journal(LigneJeu::new(horloge(), "LAUNCHER", censurer(m, s.iter().map(String::as_str)))));
    });
    let compte = compte(log).await?;
    ctx.secrets.lock().unwrap_or_else(|e| e.into_inner()).push(compte.access_token.clone());
    verifier_arret(&arret)?;
    let genre = if compte.genre == "offline" { t("launch.offline") } else { "Microsoft".into() };
    ctx.log(&tv(
        "launch.summary",
        &[("name", &instance.name), ("version", &instance.version), ("account", &compte.name), ("type", &genre)],
    ));

    // 2. Composants
    ctx.progres(1);
    let version = jeu.version_json(&instance.version).await?;
    verifier_arret(&arret)?;

    // 3. Fichiers du jeu
    ctx.progres(2);
    let libs = bibliotheques(&version, &jeu.dossiers.libraries, sys);
    let assets = jeu.preparer_assets(&version, verifier, annule.clone()).await?;
    let mut taches: Vec<_> = [jeu.tache_client(&version), jeu.tache_logs(&version)].into_iter().flatten().collect();
    taches.extend(libs.taches.iter().cloned());
    taches.extend(assets.taches.iter().cloned());
    let nombre = taches.len();
    let debut = Instant::now();
    jeu.telechargeur.tous(taches, 16, verifier, annule.clone(), Some(ctx.suivi(2))).await?;
    ctx.log(&tv("launch.files_ready", &[("count", &nombre.to_string()), ("seconds", &secondes(debut.elapsed().as_secs_f64()))]));

    // 4. Java
    ctx.progres(3);
    let requis = version.pointer("/javaVersion/majorVersion").and_then(Value::as_u64).unwrap_or(8) as u32;
    let java = if reglages.java == "custom" && !reglages.java_path.is_empty() {
        let p = PathBuf::from(&reglages.java_path);
        if !p.is_file() {
            return Err(Erreur::new(tv("launch.java_personnalise_introuvable", &[("javaPath", &reglages.java_path)])));
        }
        p
    } else {
        let composant = version.pointer("/javaVersion/component").and_then(Value::as_str).unwrap_or("jre-legacy");
        // Mac Apple Silicon, version d'avant 1.19 : ses natives n'existent qu'en Intel, donc Java Intel par Rosetta.
        let rosetta = rosetta_necessaire(&version, sys);
        if rosetta && !rosetta_installe() {
            return Err(Erreur::code(tv("launch.rosetta_manquant", &[("version", &instance.version)]), "ROSETTA_MISSING"));
        }
        if rosetta {
            ctx.log(&tv("launch.rosetta", &[("version", &instance.version)]));
        }
        jeu.runtime(composant, if rosetta { "x64" } else { sys.arch }, annule.clone(), Some(ctx.suivi(3))).await?
    };

    // 5. Loader de mods (après Java : les processeurs de Forge et NeoForge sont des programmes Java)
    ctx.progres(4);
    let mut jeu_json = version.clone();
    let mut libs_jeu = libs;
    if instance.loader != "vanilla" {
        let loader_version = instance.loader_version.clone().unwrap_or_default();
        let journal = |m: &str, tag: &str| ctx.journal(m, tag);
        let id = jeu
            .installer_loader(&DemandeLoader {
                mc: &instance.version,
                loader: &instance.loader,
                version: &loader_version,
                java: &java,
                annule: annule.clone(),
                progression: Some(ctx.suivi(4)),
                journal: &journal as loaders::Journal,
            })
            .await?;
        (ctx.rappel)(Evenement::LoaderInstalle(id.clone()));
        jeu_json = jeu.version_json(&id).await?;
        // Forge / NeoForge : le jar du jeu porte le nom de la version du loader (comme le launcher officiel).
        // Fabric / Quilt : on garde le jar vanilla tel quel, sinon Fabric confond ce jar avec le sien.
        if instance.loader == "fabric" || instance.loader == "quilt" {
            jeu_json["jar"] = version.get("jar").or_else(|| version.get("id")).cloned().unwrap_or(Value::Null);
        }
        let (cible, source) = (jeu.jar_client(&jeu_json), jeu.jar_client(&version));
        if cible != source && !cible.is_file() {
            if let Some(p) = cible.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(&source, &cible)?;
        }
        libs_jeu = bibliotheques(&jeu_json, &jeu.dossiers.libraries, sys);
        let mut t2: Vec<_> = jeu.tache_client(&jeu_json).into_iter().collect();
        t2.extend(libs_jeu.taches.iter().cloned());
        jeu.telechargeur.tous(t2, 16, verifier, annule.clone(), Some(ctx.suivi(4))).await?;
        ctx.log(&tv("launch.pret", &[("LOADER_NAMES", loader_name(&instance.loader)), ("loaderVersion", &loader_version), ("id", &id)]));
    }
    verifier_arret(&arret)?;

    // 6. Vérification de Java
    ctx.progres(5);
    let info = sonder_en_cache(&java).await?;
    ctx.log(&tv(
        "launch.java",
        &[("major", &info.major.to_string()), ("description", &info.description), ("javaExe", &java.to_string_lossy())],
    ));
    // Java 32 bits : il ne peut pas réserver plus d'environ 1,5 Go ; mieux vaut le dire que laisser Java échouer.
    if info.bits == Some(32) && reglages.ram > JAVA_32_MAX_GO {
        return Err(Erreur::code(tv("launch.java_32_bits", &[("ram", &go(reglages.ram))]), "JAVA_32_BIT"));
    }
    if info.major < requis {
        let (r, m) = (requis.to_string(), info.major.to_string());
        return Err(Erreur::new(tv(
            "launch.minecraft_demande_java_mais_ce",
            &[("version", &instance.version), ("required", &r), ("major", &m)],
        )));
    }
    if info.major != requis {
        ctx.journal(
            &tv("launch.attention_java_est_recommande_pour", &[("required", &requis.to_string()), ("major", &info.major.to_string())]),
            "LAUNCHER/WARN",
        );
    }
    // shortcut: la préférence « carte graphique dédiée » pour ce java.exe arrive avec le bureau (R6).

    // 7. Mémoire disponible (l'avertissement est affiché par l'interface avant le lancement)
    ctx.progres(6);
    let libre = (mesures::memoire_libre() as f64 / 1024f64.powi(3) * 10.0).round() / 10.0;
    ctx.log(&tv("launch.memory", &[("ram", &go(reglages.ram)), ("free", &go(libre))]));

    // 8. Natives et assets anciens
    ctx.progres(7);
    std::fs::create_dir_all(&dossier_jeu)?;
    // shortcut: l'écran titre Cristal (FancyMenu) est mis à jour avec le contenu (R4).
    let id_assets = version.pointer("/assetIndex/id").and_then(Value::as_str).unwrap_or("");
    let assets_jeu = jeu.reconstruire_assets(&assets.index, id_assets, &dossier_jeu)?;
    let chemin = |p: &Path| p.to_string_lossy().into_owned();
    let separateur = if cfg!(windows) { ";" } else { ":" };
    let mut classpath: Vec<String> = libs_jeu.classpath.iter().map(|p| chemin(p)).collect();
    classpath.push(chemin(&jeu.jar_client(&jeu_json)));
    let texte = |v: &Value, c: &str| v.get(c).and_then(Value::as_str).map(String::from);
    let vars: Variables = [
        ("auth_player_name", compte.name.clone()),
        ("version_name", texte(&jeu_json, "id").unwrap_or_default()),
        ("game_directory", chemin(&dossier_jeu)),
        ("assets_root", chemin(&jeu.dossiers.assets)),
        ("game_assets", chemin(assets_jeu.as_deref().unwrap_or(&jeu.dossiers.assets))),
        ("assets_index_name", texte(&version["assetIndex"], "id").or_else(|| texte(&version, "assets")).unwrap_or_default()),
        ("auth_uuid", compte.uuid.clone()),
        ("auth_access_token", compte.access_token.clone()),
        ("auth_session", format!("token:{}:{}", compte.access_token, compte.uuid)),
        ("auth_xuid", compte.xuid.clone()),
        ("clientid", uuid_v4()),
        ("user_type", compte.user_type.into()),
        ("user_properties", "{}".into()),
        ("version_type", texte(&jeu_json, "type").or_else(|| texte(&version, "type")).unwrap_or_default()),
        ("natives_directory", chemin(&dossier_instance.join("natives"))),
        ("launcher_name", NOM_LAUNCHER.into()),
        ("launcher_version", version_launcher),
        ("classpath", classpath.join(separateur)),
        ("classpath_separator", separateur.into()),
        ("library_directory", chemin(&jeu.dossiers.libraries)),
        ("resolution_width", reglages.width.to_string()),
        ("resolution_height", reglages.height.to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let config_logs = jeu.tache_logs(&jeu_json).map(|t| t.chemin);
    // Le jeu note dans ce fichier le monde ou le serveur rejoint (1.20 et plus) : c'est la liste « Reprendre ».
    let fichier_qp = fichier_quick_play(&dossier_instance);
    let _ = std::fs::remove_file(&fichier_qp);
    let ligne = arguments::construire(DemandeArgs {
        config_logs: config_logs.as_deref(),
        quick_play: quick_play.as_ref(),
        fichier_quick_play: Some(&fichier_qp),
        java: info.major,
        ..DemandeArgs::new(&jeu_json, vars, reglages)
    });
    if let Some(qp) = &quick_play {
        let nom = if qp.name.is_empty() { &qp.id } else { &qp.name };
        match ligne.quick_play {
            None => ctx.log(&tv("launch.quick_play_impossible", &[("name", nom)])),
            Some(rejoint) => {
                ctx.log(&tv(
                    if rejoint == "singleplayer" { "launch.quick_play_monde" } else { "launch.quick_play_serveur" },
                    &[("name", nom)],
                ));
                // Premier lancement : l'écran d'accessibilité du jeu bloquerait l'entrée directe.
                if passer_accessibilite(&dossier_jeu)? {
                    ctx.log(&t("launch.ecran_accessibilite_passe"));
                }
            }
        }
    }
    let gc = t(match ligne.gc {
        "g1" => "launch.g1_regle",
        "zgc" => "launch.zgc_generationnel",
        _ => "launch.celui_de_java_par_defaut",
    });
    ctx.log(&tv(if reglages.jvm_preset == "auto" { "launch.gc_auto" } else { "launch.gc" }, &[("gc", &gc)]));
    let extraites = extraire_natives(&libs_jeu.natives, &ligne.natives)?;
    ctx.log(&tv("launch.natives_extraites", &[("extracted", &extraites.to_string())]));
    verifier_arret(&arret)?;

    if preparer_seulement {
        ctx.log(&t("launch.fichiers_verifies_java_et_natives"));
        return Ok(None);
    }

    // 9. Lancement
    ctx.progres(8);
    let classe = texte(&jeu_json, "mainClass").unwrap_or_default();
    ctx.log(&tv("launch.arguments_du_jeu", &[("gameArgs", &ligne.jeu.join(" "))]));
    let mut args = ligne.jvm;
    args.push(classe);
    args.extend(ligne.jeu);
    Ok(Some(Partie { java, args, dossier_jeu, priorite: reglages.priority.clone() }))
}

/// Identifiant aléatoire au format UUID v4 (clientid du jeu).
fn uuid_v4() -> String {
    let mut o: [u8; 16] = std::array::from_fn(|_| fastrand::u8(..));
    o[6] = (o[6] & 0x0f) | 0x40;
    o[8] = (o[8] & 0x3f) | 0x80;
    let h: String = o.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// Lit une sortie du jeu par morceaux (UTF-8 coupé au milieu d'un caractère compris).
async fn lire(mut flux: impl AsyncRead + Unpin, tag: &'static str, ctx: Arc<(Rappel, Vec<String>)>) {
    let mut lecteur = LecteurSortie::new(tag);
    let mut reste: Vec<u8> = vec![];
    let mut tampon = vec![0u8; 16 * 1024];
    let envoyer = |lignes: Vec<LigneJeu>| {
        for mut l in lignes {
            l.msg = censurer(&l.msg, ctx.1.iter().map(String::as_str));
            (ctx.0)(Evenement::Journal(l));
        }
    };
    loop {
        let n = match flux.read(&mut tampon).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        reste.extend_from_slice(&tampon[..n]);
        let valide = match std::str::from_utf8(&reste) {
            Ok(_) => reste.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => reste.len(),
        };
        let texte = String::from_utf8_lossy(&reste[..valide]).into_owned();
        reste.drain(..valide);
        let mut lignes = vec![];
        lecteur.pousser(&texte, &mut lignes);
        envoyer(lignes);
    }
    let mut lignes = vec![];
    if !reste.is_empty() {
        lecteur.pousser(&String::from_utf8_lossy(&reste), &mut lignes);
    }
    lecteur.vider(&mut lignes);
    envoyer(lignes);
}

/// Arrête le jeu : demande polie (Linux, macOS), puis forcée après `grace`. Windows : tout de suite.
async fn arreter(enfant: &mut tokio::process::Child, grace: Duration) {
    #[cfg(unix)]
    if let Some(pid) = enfant.id() {
        let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status();
        if tokio::time::timeout(grace, enfant.wait()).await.is_ok() {
            return;
        }
    }
    let _ = grace;
    let _ = enfant.start_kill();
}

async fn jouer(p: Partie, ctx: &Contexte, arret: &CancellationToken) {
    let secrets = ctx.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut enfant = match commande(&p.java)
        .args(&p.args)
        .current_dir(&p.dossier_jeu)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(e) => e,
        Err(e) => {
            ctx.journal(&tv("launch.impossible_de_demarrer_java", &[("message", &e.to_string())]), "LAUNCHER/ERROR");
            let code = e.raw_os_error().map(|c| c.to_string()).unwrap_or_else(|| e.kind().to_string());
            (ctx.rappel)(Evenement::Echec {
                message: tv("launch.impossible_de_demarrer_java_2", &[("code", &code)]),
                annule: false,
                code: None,
            });
            return;
        }
    };
    let debut = Instant::now();
    let partage = Arc::new((ctx.rappel.clone(), secrets));
    let lecteurs = [
        tokio::spawn(lire(enfant.stdout.take().expect("stdout"), "sortie/INFO", partage.clone())),
        tokio::spawn(lire(enfant.stderr.take().expect("stderr"), "sortie/WARN", partage)),
    ];
    let pid = enfant.id().unwrap_or(0);
    ctx.log(&tv("launch.minecraft_demarre_processus", &[("pid", &pid.to_string())]));
    if p.priorite == "above" {
        match mesures::priorite_haute(pid) {
            Ok(()) => ctx.log(&t("launch.priorite_du_jeu_au_dessus")),
            Err(e) => ctx.journal(&tv("launch.priorite_du_jeu_inchangee", &[("code", &e)]), "LAUNCHER/WARN"),
        }
    }
    (ctx.rappel)(Evenement::Demarre { pid });

    let mut arrete = false;
    let statut = tokio::select! {
        s = enfant.wait() => s,
        _ = arret.cancelled() => {
            arrete = true;
            arreter(&mut enfant, Duration::from_secs(10)).await;
            enfant.wait().await
        }
    };
    // Un programme lancé par le jeu peut garder ses sorties ouvertes après sa fin : on n'attend pas plus de 2 s.
    for l in lecteurs {
        let _ = tokio::time::timeout(Duration::from_secs(2), l).await;
    }
    let code = statut.ok().and_then(|s| s.code());
    let minutes = (debut.elapsed().as_secs_f64() / 60.0).round() as u64;
    let plante = !arrete && code != Some(0);
    let message = if arrete {
        t("launch.jeu_arrete_depuis_le_launcher")
    } else {
        tv("launch.jeu_ferme_code_de_sortie", &[("code", &code.map_or_else(|| "?".into(), |c| c.to_string()))])
    };
    ctx.journal(&message, if plante { "LAUNCHER/ERROR" } else { "LAUNCHER" });
    (ctx.rappel)(Evenement::Fin { code, plante, minutes });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;

    #[test]
    fn ecran_d_accessibilite() {
        let d = Dossier::nouveau("accessibilite");
        assert!(passer_accessibilite(&d.0.join("jeu")).unwrap());
        assert_eq!(std::fs::read_to_string(d.0.join("jeu/options.txt")).unwrap(), "onboardAccessibility:false\n");
        assert!(!passer_accessibilite(&d.0.join("jeu")).unwrap());
        d.ecrire("b/options.txt", "fov:0.0\nonboardAccessibility:true\nlang:fr_fr");
        assert!(passer_accessibilite(&d.0.join("b")).unwrap());
        assert_eq!(std::fs::read_to_string(d.0.join("b/options.txt")).unwrap(), "fov:0.0\nonboardAccessibility:false\nlang:fr_fr");
        d.ecrire("c/options.txt", "fov:0.0");
        assert!(passer_accessibilite(&d.0.join("c")).unwrap());
        assert_eq!(std::fs::read_to_string(d.0.join("c/options.txt")).unwrap(), "fov:0.0\nonboardAccessibility:false\n");
    }

    #[test]
    fn identifiant_aleatoire() {
        let u = uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!("89ab".contains(&u[19..20]));
    }
}
