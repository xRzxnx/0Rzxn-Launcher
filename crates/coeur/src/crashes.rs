//! Rapports de crash, comme core/crashes.js : rapports du jeu (crash-reports), plantages de Java (hs_err_pid*.log) et
//! logs gardés par le launcher quand le jeu s'arrête sur une erreur. Chaque rapport est expliqué quand l'erreur est
//! connue, et peut être partagé sur mclo.gs.

use crate::erreur::{Erreur, Resultat};
use crate::i18n::{go, t, tv};
use crate::net::{Options, Reseau};
use crate::sortie_jeu::LigneJeu;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const DOSSIER_LOGS: &str = "crash-logs";
const GARDER_LOGS: usize = 15;
const TEXTE_MAX: u64 = 4 * 1024 * 1024;

/// Dossiers d'une instance.
pub struct Dossiers<'a> {
    pub jeu: &'a Path,
    pub instance: &'a Path,
}

fn regle(source: &str) -> Option<(&'static Regex, &'static str)> {
    static RAPPORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^crash-.+\.txt$").unwrap());
    static JVM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^hs_err_pid\d+\.log$").unwrap());
    static LOG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^launcher-[\d_-]+\.log$").unwrap());
    match source {
        "report" => Some((&RAPPORT, "crashes.kind_report")),
        "jvm" => Some((&JVM, "crashes.kind_jvm")),
        "log" => Some((&LOG, "crashes.kind_log")),
        _ => None,
    }
}

fn dossier(d: &Dossiers, source: &str) -> PathBuf {
    match source {
        "report" => d.jeu.join("crash-reports"),
        "jvm" => d.jeu.to_path_buf(),
        _ => d.instance.join(DOSSIER_LOGS),
    }
}

/// Chemin d'un rapport ; la règle de nom protège des chemins arbitraires.
pub fn fichier_crash(d: &Dossiers, source: &str, fichier: &str) -> Resultat<PathBuf> {
    match regle(source) {
        Some((nom, _)) if !fichier.contains(['/', '\\']) && nom.is_match(fichier) => Ok(dossier(d, source).join(fichier)),
        _ => Err(Erreur::new(t("crashes.rapport_invalide"))),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Crash {
    pub source: &'static str,
    pub file: String,
    pub kind: String,
    /// Date de modification (ms).
    pub at: f64,
    pub size: u64,
}

pub fn lister(d: &Dossiers) -> Vec<Crash> {
    let mut trouves = vec![];
    for source in ["report", "jvm", "log"] {
        let (nom, genre) = regle(source).expect("source connue");
        let Ok(it) = std::fs::read_dir(dossier(d, source)) else { continue };
        for e in it.flatten() {
            let file = e.file_name().to_string_lossy().into_owned();
            let Ok(m) = e.metadata() else { continue };
            if !nom.is_match(&file) || !m.is_file() {
                continue;
            }
            let at = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            trouves.push(Crash { source, file, kind: t(genre), at, size: m.len() });
        }
    }
    trouves.sort_by(|a, b| b.at.total_cmp(&a.at));
    trouves
}

/// Texte d'un rapport ; un log énorme garde sa fin, là où se trouve l'erreur. Renvoie (texte, tronqué).
pub fn lire_texte(fichier: &Path) -> Resultat<(String, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(fichier)?;
    let taille = f.metadata()?.len();
    let debut = taille.saturating_sub(TEXTE_MAX);
    f.seek(SeekFrom::Start(debut))?;
    let mut octets = vec![];
    f.read_to_end(&mut octets)?;
    Ok((String::from_utf8_lossy(&octets).into_owned(), debut > 0))
}

/// Le jeu s'est arrêté sur une erreur sans rapport du jeu : on garde ses derniers logs (déjà masqués).
pub fn garder_log(dossier_instance: &Path, lignes: &[LigneJeu], code: Option<i32>) -> Resultat<String> {
    let d = dossier_instance.join(DOSSIER_LOGS);
    std::fs::create_dir_all(&d)?;
    let fichier = format!("launcher-{}.log", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"));
    let corps: Vec<String> = lignes.iter().map(|l| format!("[{}] [{}]: {}", l.time, l.tag, l.msg)).collect();
    let code = code.map_or_else(|| "null".into(), |c| c.to_string());
    std::fs::write(d.join(&fichier), tv("crashes.0rzxn_launcher_jeu_ferme_avec", &[("body", &corps.join("\n")), ("code", &code)]))?;
    let (nom, _) = regle("log").expect("source connue");
    let mut anciens: Vec<String> =
        std::fs::read_dir(&d)?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| nom.is_match(n)).collect();
    anciens.sort();
    for n in &anciens[..anciens.len().saturating_sub(GARDER_LOGS)] {
        let _ = std::fs::remove_file(d.join(n));
    }
    Ok(fichier)
}

// ---------- Explications ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    #[serde(rename = "type")]
    pub genre: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
}

fn action(genre: &'static str, label: String) -> Action {
    Action { genre, label, slug: None, mod_id: None }
}
fn desactiver(mod_id: &str, label: String) -> Action {
    Action { mod_id: Some(mod_id.into()), ..action("disable", label) }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Probleme {
    pub id: &'static str,
    pub label: String,
    pub title: String,
    pub text: String,
    pub advice: String,
    pub actions: Vec<Action>,
    pub lines: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suspect {
    pub name: String,
    pub mod_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnostic {
    pub problems: Vec<Probleme>,
    pub suspects: Vec<Suspect>,
}

/// Contexte de la partie : Java utilisé, mémoire (Go), mode Java (« auto » ou « custom »).
#[derive(Debug, Clone, Default)]
pub struct ContexteCrash {
    pub java: Option<u32>,
    pub ram: Option<f64>,
    pub java_mode: String,
}

/// Identifiant de mod → projet Modrinth, quand ils diffèrent.
fn slug(id: &str) -> String {
    match id {
        "fabric" | "fabric_api" | "fabric-api-base" => "fabric-api".into(),
        "cloth_config" => "cloth-config".into(),
        "architectury" => "architectury-api".into(),
        "yet_another_config_lib_v3" | "yet-another-config-lib" => "yacl".into(),
        "owo" => "owo-lib".into(),
        "forgeconfigapiport" => "forge-config-api-port".into(),
        "kotlinforforge" => "kotlin-for-forge".into(),
        "puzzleslib" => "puzzles-lib".into(),
        autre => autre.replace('_', "-"),
    }
}

/// Noms affichés des dépendances courantes (les rapports Forge ne donnent que l'identifiant).
fn nom_connu(id: &str) -> Option<&'static str> {
    Some(match id {
        "fabric" | "fabric-api" | "fabric_api" => "Fabric API",
        "fabric-language-kotlin" => "Fabric Language Kotlin",
        "sodium" => "Sodium",
        "cloth-config" | "cloth_config" => "Cloth Config",
        "architectury" => "Architectury API",
        "geckolib" => "GeckoLib",
        "modmenu" => "Mod Menu",
        "yet_another_config_lib_v3" => "YetAnotherConfigLib",
        "kotlinforforge" => "Kotlin for Forge",
        "forgeconfigapiport" => "Forge Config API Port",
        "balm" => "Balm",
        "owo" => "oωo",
        _ => return None,
    })
}

const INTEGRES: [&str; 9] = ["minecraft", "java", "fabricloader", "fabric-loader", "quilt_loader", "forge", "neoforge", "fml", "javafml"];

fn re(motif: &str) -> Regex {
    Regex::new(motif).expect("expression valide")
}

static DEP: &str = r"(?:mod )?(?:'([^']+)' \(([^)]+)\)|([\w.-]+))";
static FABRIC_DEMANDE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"Mod '([^']+)' \(([^)]+)\) (\S+) requires (.+?) of {DEP}, (which is missing|but only the wrong version is present: ([^!\s]+))"
    ))
});
static FABRIC_CASSE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"Mod '([^']+)' \(([^)]+)\) (\S+) is incompatible with (.+?) of {DEP}")));
static FORGE_DEP: LazyLock<Regex> =
    LazyLock::new(|| re(r"Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '([^']*)'"));

struct Demandeur<'a> {
    name: &'a str,
    id: Option<&'a str>,
    version: Option<&'a str>,
}

impl Demandeur<'_> {
    fn complet(&self) -> String {
        [Some(self.name), self.version].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }
}

struct Analyse<'c> {
    problemes: Vec<(String, Probleme)>,
    ctx: &'c ContexteCrash,
}

fn nombre_dans(texte: &str) -> Option<String> {
    texte.split(|c: char| !c.is_ascii_digit()).find(|s| !s.is_empty()).map(String::from)
}

impl Analyse<'_> {
    fn ajouter(&mut self, cle: &str, p: Probleme, ligne: Option<usize>) {
        if let Some((_, connu)) = self.problemes.iter_mut().find(|(k, _)| k == cle) {
            if let Some(l) = ligne.filter(|l| !connu.lines.contains(l)) {
                connu.lines.push(l);
            }
            return;
        }
        self.problemes.push((cle.into(), Probleme { lines: ligne.into_iter().collect(), ..p }));
    }

    fn java(&mut self, besoin: Option<String>, a: Option<String>, ligne: usize) {
        let perso = self.ctx.java_mode == "custom";
        let (b, h) = (besoin.clone().unwrap_or_default(), a.clone().unwrap_or_default());
        let vars = [("need", b.as_str()), ("have", h.as_str())];
        let titre = match (&besoin, &a) {
            (Some(_), Some(_)) => tv("crashes.need_java_not", &vars),
            (Some(_), None) => tv("crashes.need_java", &vars),
            _ => t("crashes.cette_version_de_java_ne"),
        };
        let texte = match (&besoin, &a) {
            (Some(_), Some(_)) => "crashes.compiled_for_need_have",
            (Some(_), None) => "crashes.compiled_for_need",
            (None, Some(_)) => "crashes.compiled_for_have",
            _ => "crashes.compiled_for",
        };
        let p = Probleme {
            id: "java",
            label: t("crashes.java_incompatible"),
            title: titre,
            text: tv(texte, &vars),
            advice: t(if perso { "crashes.ton_instance_utilise_un_java" } else { "crashes.si_un_seul_mod_demande" }),
            actions: vec![if perso {
                action("settings", t("crashes.ouvrir_les_reglages_java"))
            } else {
                action("mods", t("crashes.ouvrir_onglet_mods"))
            }],
            lines: vec![],
        };
        self.ajouter("java", p, Some(ligne));
    }

    fn manquant(&mut self, d: &Demandeur, dep: &str, nom_brut: Option<&str>, plage: Option<&str>, ligne: usize) {
        if dep == "java" {
            let besoin = plage.and_then(nombre_dans);
            return self.java(besoin, self.ctx.java.map(|j| j.to_string()), ligne);
        }
        if INTEGRES.contains(&dep) {
            return;
        }
        let nom = nom_brut.or_else(|| nom_connu(dep)).unwrap_or(dep);
        let plage = plage.filter(|p| !p.is_empty() && *p != "any version").map(|p| format!(" ({p})")).unwrap_or_default();
        let mut actions = vec![Action { slug: Some(slug(dep)), ..action("install", tv("crashes.installer", &[("depName", nom)])) }];
        if let Some(id) = d.id {
            actions.push(desactiver(id, tv("crashes.desactiver", &[("name", d.name)])));
        }
        let p = Probleme {
            id: "missing",
            label: t("crashes.mod_manquant"),
            title: tv("crashes.besoin_de_qui_est_pas", &[("name", d.name), ("depName", nom)]),
            text: tv("crashes.missing_dep_text", &[("mod", &d.complet()), ("dep", &format!("{nom}{plage}"))]),
            advice: tv("crashes.installe_pour_cette_version_de", &[("depName", nom), ("name", d.name)]),
            actions,
            lines: vec![],
        };
        self.ajouter(&format!("missing:{dep}"), p, Some(ligne));
    }

    fn mauvaise_version(&mut self, d: &Demandeur, dep: &str, nom_dep: Option<&str>, plage_brute: &str, presente: &str, ligne: usize) {
        // « version 1.21.4 » (Fabric) ou « [1.20.4] » (Forge) : on garde le numéro seul.
        static VERSION: LazyLock<Regex> = LazyLock::new(|| re(r"^versions? "));
        static CROCHETS: LazyLock<Regex> = LazyLock::new(|| re(r"^\[([^,\]]+)\]$"));
        let plage = VERSION.replace(plage_brute, "");
        let plage = CROCHETS.replace(&plage, "$1").into_owned();
        if dep == "java" {
            let presente = presente.split(|c: char| !c.is_ascii_digit()).next().filter(|s| !s.is_empty()).map(String::from);
            return self.java(nombre_dans(&plage), presente, ligne);
        }
        let jeu = dep == "minecraft";
        let nom = nom_dep.unwrap_or(dep);
        let id = d.id.unwrap_or("");
        let p = Probleme {
            id: "version",
            label: t(if jeu { "crashes.mod_pour_une_autre_version" } else { "crashes.mauvaise_version_de_dependance" }),
            title: if jeu {
                tv("crashes.est_fait_pour_minecraft", &[("name", d.name), ("range", &plage)])
            } else {
                tv("crashes.demande_une_autre_version_de", &[("name", d.name), ("depName", nom)])
            },
            text: tv("crashes.wrong_dep_text", &[("mod", &d.complet()), ("dep", nom), ("range", &plage), ("present", presente)]),
            advice: if jeu {
                tv("crashes.remplace_par_sa_version_pour", &[("name", d.name), ("present", presente)])
            } else {
                tv("crashes.mets_jour_ou_depuis_onglet", &[("depName", nom), ("name", d.name)])
            },
            actions: vec![desactiver(id, tv("crashes.desactiver", &[("name", d.name)])), action("mods", t("crashes.ouvrir_onglet_mods"))],
            lines: vec![],
        };
        self.ajouter(&format!("version:{id}:{dep}"), p, Some(ligne));
    }

    fn memoire(&mut self, cle: &str, titre: &str, texte: String, conseil: &str, ligne: usize) {
        let p = Probleme {
            id: "memory",
            label: t("crashes.memoire_insuffisante"),
            title: t(titre),
            text: texte,
            advice: t(conseil),
            actions: vec![action("settings", t("crashes.changer_la_memoire"))],
            lines: vec![],
        };
        self.ajouter(cle, p, Some(ligne));
    }
}

fn probleme_gpu(fabricant: Option<&str>, dll: Option<&str>) -> Probleme {
    let site = match fabricant {
        Some("NVIDIA") => " (GeForce Experience, nvidia.com)",
        Some("AMD") => " (AMD Software, amd.com)",
        Some("Intel") => " (intel.com)",
        _ => "",
    };
    let f = fabricant.unwrap_or("");
    Probleme {
        id: "gpu",
        label: t("crashes.pilote_graphique"),
        title: if fabricant.is_some() {
            tv("crashes.le_pilote_graphique_plante", &[("vendor", f)])
        } else {
            t("crashes.le_pilote_graphique_ne_convient")
        },
        text: match dll {
            Some(d) => tv("crashes.java_est_arrete_dans_un", &[("dll", d)]),
            None => t("crashes.le_jeu_pas_pu_ouvrir"),
        },
        advice: tv(
            if fabricant.is_some() { "crashes.driver_advice_vendor" } else { "crashes.driver_advice" },
            &[("vendor", f), ("site", site)],
        ),
        actions: vec![],
        lines: vec![],
    }
}

/// « Suspected Mods: Sodium (sodium), Iris (iris) » dans les rapports du jeu.
fn mods_suspects(lignes: &[&str]) -> Vec<Suspect> {
    static TETE: LazyLock<Regex> = LazyLock::new(|| re(r"Suspected Mods?:"));
    static RIEN: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(NONE|Unknown|~~ERROR~~)"));
    static MOD: LazyLock<Regex> = LazyLock::new(|| re(r"([^,()]+?) \(([\w.-]+)\)"));
    let Some(i) = lignes.iter().position(|l| TETE.is_match(l)) else { return vec![] };
    let reste = TETE.splitn(lignes[i], 2).nth(1).unwrap_or("").trim();
    let texte = if reste.is_empty() { lignes.get(i + 1).map_or("", |l| l.trim()) } else { reste };
    if texte.is_empty() || RIEN.is_match(texte) {
        return vec![];
    }
    MOD.captures_iter(texte).take(5).map(|c| Suspect { name: c[1].trim().into(), mod_id: c[2].into() }).collect()
}

fn probleme_inconnu(lignes: &[&str], suspects: &[Suspect]) -> Probleme {
    static ERREUR: LazyLock<Regex> = LazyLock::new(|| re(r"^\S*(Exception|Error)\b.*?:|^Caused by: "));
    let description = lignes.iter().position(|l| l.starts_with("Description: "));
    let a = lignes.iter().position(|l| ERREUR.is_match(l.trim()));
    let erreur: Option<String> = a.map(|i| lignes[i].trim().chars().take(200).collect());
    let lines = [a, description].into_iter().flatten().collect();
    if !suspects.is_empty() {
        let noms = suspects.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ");
        let n = suspects.len().to_string();
        let e = erreur.clone().unwrap_or_default();
        return Probleme {
            id: "suspect",
            label: t("crashes.mod_en_cause"),
            title: tv("crashes.le_plantage_vient_sans_doute", &[("names", &noms)]),
            text: tv(if erreur.is_some() { "crashes.suspect_error" } else { "crashes.suspect" }, &[("count", &n), ("error", &e)]),
            advice: tv("crashes.suspect_advice", &[("count", &n)]),
            actions: suspects.iter().take(2).map(|s| desactiver(&s.mod_id, tv("crashes.desactiver", &[("name", &s.name)]))).collect(),
            lines,
        };
    }
    Probleme {
        id: "unknown",
        label: t("crashes.erreur_inconnue"),
        title: t("crashes.le_launcher_ne_reconnait_pas"),
        text: match &erreur {
            Some(e) => tv("crashes.le_jeu_est_arrete_sur", &[("error", e)]),
            None => t("crashes.le_jeu_est_arrete_sans"),
        },
        advice: t("crashes.partage_le_rapport_sur_mclo"),
        actions: vec![],
        lines,
    }
}

/// Explique un rapport : problèmes reconnus (au moins un) et mods suspectés.
pub fn diagnostiquer(texte: &str, ctx: &ContexteCrash) -> Diagnostic {
    static CLASSE: LazyLock<Regex> =
        LazyLock::new(|| re(r"UnsupportedClassVersionError.*?class file version (\d+)(?:\.\d+)?\).*?up to (\d+)(?:\.\d+)?"));
    static URL_LOADER: LazyLock<Regex> = LazyLock::new(|| re(r"AppClassLoader cannot be cast to (?:class )?java\.net\.URLClassLoader"));
    static FABRIC_API: LazyLock<Regex> =
        LazyLock::new(|| re(r"NoClassDefFoundError: net/fabricmc/fabric/api|ClassNotFoundException: net\.fabricmc\.fabric\.api"));
    static OOM: LazyLock<Regex> = LazyLock::new(|| re(r"java\.lang\.OutOfMemoryError(?:: (.+))?"));
    static RESERVE: LazyLock<Regex> = LazyLock::new(|| re(r"Could not reserve enough space for .*object heap|Invalid maximum heap size"));
    static NATIVE: LazyLock<Regex> = LazyLock::new(|| re(r"There is insufficient memory for the Java Runtime Environment"));
    static OPENGL: LazyLock<Regex> = LazyLock::new(|| {
        re(r"(?i)Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL|No OpenGL context found")
    });
    static MIXIN: LazyLock<Regex> = LazyLock::new(|| re(r"Mixin apply(?: for mod ([\w.-]+))? failed:? ?([\w.-]+\.json)?"));
    static MIXIN2: LazyLock<Regex> = LazyLock::new(|| {
        re(r"(?:MixinApplyError|InvalidInjectionException|InvalidMixinException|MixinTransformerError).*?([\w-]+)\.mixins?\.json")
    });
    static FIN_MIXIN: LazyLock<Regex> = LazyLock::new(|| re(r"(\.client|\.common)?\.mixins?\.json$"));
    static ZIP: LazyLock<Regex> = LazyLock::new(|| {
        re(r"java\.util\.zip\.ZipException|zip END header not found|invalid LOC header|error in opening zip file|ZipError")
    });
    static JAR: LazyLock<Regex> = LazyLock::new(|| re(r"([\w.+-]+\.jar)"));
    static JAVA32: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)Java HotSpot\(TM\) Client VM|JVM is 32-bit|32-bit Java"));
    static CADRE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^#\s+C\s+\[([\w.-]+\.dll)\+"));
    static DLL_GPU: LazyLock<[(Regex, Option<&str>); 4]> = LazyLock::new(|| {
        [
            (re(r"(?i)^(atio6axx|atioglxx|atig6pxx|atig6txx|amdxc64|amdxx64)"), Some("AMD")),
            (re(r"(?i)^nvoglv"), Some("NVIDIA")),
            (re(r"(?i)^ig\w*icd"), Some("Intel")),
            (re(r"(?i)^opengl32"), None),
        ]
    });
    let classe_java = |v: &str| v.parse::<i64>().map(|n| (n - 44).to_string()).ok();

    let lignes: Vec<&str> = texte.lines().collect();
    let mut a = Analyse { problemes: vec![], ctx };
    let mut cadre: Option<(String, usize)> = None;
    let mut violation = false;
    for (i, ligne) in lignes.iter().enumerate() {
        if let Some(m) = FABRIC_DEMANDE.captures(ligne) {
            let d = Demandeur { name: m.get(1).unwrap().as_str(), id: m.get(2).map(|x| x.as_str()), version: m.get(3).map(|x| x.as_str()) };
            let dep = m.get(6).or(m.get(7)).map_or("", |x| x.as_str());
            if &m[8] == "which is missing" {
                a.manquant(&d, dep, m.get(5).map(|x| x.as_str()), Some(&m[4]), i);
            } else {
                a.mauvaise_version(&d, dep, m.get(5).map(|x| x.as_str()), &m[4], m.get(9).map_or("", |x| x.as_str()), i);
            }
        } else if let Some(m) = FABRIC_CASSE.captures(ligne) {
            let autre = m.get(5).or(m.get(6)).or(m.get(7)).map_or("", |x| x.as_str());
            let p = Probleme {
                id: "incompatible",
                label: t("common.mods_incompatibles"),
                title: tv("crashes.ne_fonctionne_pas_avec", &[("m", &m[1]), ("other", autre)]),
                text: tv("crashes.declare_etre_incompatible_avec_les", &[("m", &m[1]), ("other", autre)]),
                advice: t("crashes.desactive_un_des_deux"),
                actions: vec![desactiver(&m[2], tv("crashes.desactiver_2", &[("m", &m[1])]))],
                lines: vec![],
            };
            a.ajouter(&format!("breaks:{}:{autre}", &m[2]), p, Some(i));
        } else if let Some(m) = FORGE_DEP.captures(ligne) {
            let d = Demandeur { name: m.get(2).unwrap().as_str(), id: m.get(2).map(|x| x.as_str()), version: None };
            if &m[4] == "[MISSING]" {
                a.manquant(&d, &m[1], None, Some(&m[3]), i);
            } else {
                a.mauvaise_version(&d, &m[1], None, &m[3], &m[4], i);
            }
        } else if let Some(m) = CLASSE.captures(ligne) {
            a.java(classe_java(&m[1]), classe_java(&m[2]), i);
        } else if URL_LOADER.is_match(ligne) {
            a.java(Some("8".into()), ctx.java.map(|j| j.to_string()), i);
        } else if FABRIC_API.is_match(ligne) {
            let d = Demandeur { name: &t("crashes.un_mod"), id: None, version: None };
            a.manquant(&d, "fabric-api", Some("Fabric API"), None, i);
        } else if let Some(m) = OOM.captures(ligne) {
            let ram = ctx.ram.map(|r| format!(" ({})", go(r))).unwrap_or_default();
            let detail = m.get(1).map(|x| tv("crashes.oom_detail", &[("message", x.as_str().trim())])).unwrap_or_default();
            let texte = tv("crashes.oom_heap_text", &[("detail", &format!("{ram}{detail}"))]);
            a.memoire("memory", "crashes.le_jeu_manque_de_memoire", texte, "crashes.donne_plus_de_memoire_instance", i);
        } else if RESERVE.is_match(ligne) {
            let ram = ctx.ram.map(|r| format!(" ({})", go(r))).unwrap_or_default();
            let texte = tv("crashes.oom_reserve_text", &[("detail", &ram)]);
            a.memoire("reserve", "crashes.java_pas_pu_reserver_la", texte, "crashes.baisse_la_memoire_de_instance", i);
        } else if NATIVE.is_match(ligne) {
            let texte = t("crashes.java_demande_de_la_memoire");
            a.memoire("native-memory", "crashes.ton_pc_avait_plus_assez", texte, "crashes.ferme_des_programmes_navigateur_autres", i);
        } else if OPENGL.is_match(ligne) {
            a.ajouter("gpu", probleme_gpu(None, None), Some(i));
        } else if let Some(m) = MIXIN.captures(ligne).or_else(|| MIXIN2.captures(ligne)) {
            let (m1, m2) = (m.get(1).map(|x| x.as_str()), m.get(2).map(|x| x.as_str()));
            let module = match m1 {
                Some(x) if !x.ends_with(".json") => Some(x.to_string()),
                _ => Some(FIN_MIXIN.replace(m2.or(m1).unwrap_or(""), "").into_owned()).filter(|x| !x.is_empty()),
            };
            let nom = module.clone().unwrap_or_default();
            let mut actions = vec![];
            if let Some(x) = &module {
                actions.push(desactiver(x, tv("crashes.desactiver_3", &[("mod", x)])));
            }
            actions.push(action("mods", t("crashes.ouvrir_onglet_mods")));
            let p = Probleme {
                id: "mixin",
                label: t("crashes.mod_incompatible"),
                title: if module.is_some() {
                    tv("crashes.pas_pu_modifier_le_jeu", &[("mod", &nom)])
                } else {
                    t("crashes.un_mod_pas_pu_modifier")
                },
                text: tv(if module.is_some() { "crashes.mixin_text_mod" } else { "crashes.mixin_text" }, &[("mod", &nom)]),
                advice: if module.is_some() {
                    tv("crashes.mets_jour_ou_desactive_le", &[("mod", &nom)])
                } else {
                    t("crashes.mets_tes_mods_jour_depuis")
                },
                actions,
                lines: vec![],
            };
            a.ajouter(&format!("mixin:{}", module.as_deref().unwrap_or("null")), p, Some(i));
        } else if ZIP.is_match(ligne) {
            let jar = JAR.captures(ligne).or_else(|| lignes.get(i + 1).and_then(|l| JAR.captures(l))).map(|c| c[1].to_string());
            let j = jar.clone().unwrap_or_default();
            let p = Probleme {
                id: "corrupt",
                label: t("crashes.fichier_abime"),
                title: if jar.is_some() {
                    tv("crashes.le_fichier_est_abime", &[("jar", &j)])
                } else {
                    t("crashes.un_fichier_jar_est_abime")
                },
                text: t("crashes.java_arrive_pas_ouvrir_une"),
                advice: if jar.is_some() {
                    tv("crashes.supprime_et_reinstalle_le_puis", &[("jar", &j)])
                } else {
                    t("crashes.lance_verifier_nouveau_sur_accueil")
                },
                actions: vec![action("verify", t("crashes.verifier_les_fichiers"))],
                lines: vec![],
            };
            a.ajouter("corrupt", p, Some(i));
        } else if JAVA32.is_match(ligne) {
            let p = Probleme {
                id: "java32",
                label: t("crashes.java_32_bits"),
                title: t("crashes.le_jeu_tourne_avec_un"),
                text: t("crashes.un_java_32_bits_ne"),
                advice: t("crashes.repasse_en_java_automatique_le"),
                actions: vec![action("settings", t("crashes.ouvrir_les_reglages_java"))],
                lines: vec![],
            };
            a.ajouter("java32", p, Some(i));
        } else if ligne.contains("EXCEPTION_ACCESS_VIOLATION") {
            violation = true;
        } else if let Some(m) = CADRE.captures(ligne) {
            cadre = Some((m[1].to_string(), i));
        }
    }
    if violation
        && let Some((dll, ligne)) = cadre
        && let Some((_, fabricant)) = DLL_GPU.iter().find(|(r, _)| r.is_match(&dll))
    {
        a.ajouter("gpu", probleme_gpu(*fabricant, Some(&dll)), Some(ligne));
    }
    let suspects = mods_suspects(&lignes);
    let mut problems: Vec<Probleme> = a.problemes.into_iter().map(|(_, p)| p).collect();
    if problems.is_empty() {
        problems.push(probleme_inconnu(&lignes, &suspects));
    }
    Diagnostic { problems, suspects }
}

// ---------- Partage ----------

/// Retire ce qui identifie l'utilisateur avant l'envoi : nom de session, jetons.
pub fn nettoyer(texte: &str) -> String {
    static ARGS: LazyLock<Regex> = LazyLock::new(|| re(r"(--accessToken|--uuid|--xuid|--clientId)(\s+)\S+"));
    static JWT: LazyLock<Regex> = LazyLock::new(|| re(r"eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}"));
    let mut s = JWT.replace_all(&ARGS.replace_all(texte, "$1$2••••••••"), "••••••••").into_owned();
    let utilisateur = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    if utilisateur.chars().count() >= 3 {
        s = s
            .replace(&format!("\\Users\\{utilisateur}"), "\\Users\\<utilisateur>")
            .replace(&format!("/Users/{utilisateur}"), "/Users/<utilisateur>");
    }
    s
}

fn encoder_formulaire(texte: &str) -> String {
    texte
        .bytes()
        .map(|b| match b {
            b' ' => "+".into(),
            b'*' | b'-' | b'.' | b'_' => (b as char).to_string(),
            b if b.is_ascii_alphanumeric() => (b as char).to_string(),
            b => format!("%{b:02X}"),
        })
        .collect()
}

/// Envoie le texte sur mclo.gs (25 000 lignes et 10 Mo au plus) ; renvoie (url, id).
pub async fn partager(reseau: &Reseau, texte: &str) -> Resultat<(String, String)> {
    let mut contenu = nettoyer(texte);
    let lignes: Vec<&str> = contenu.split('\n').collect();
    if lignes.len() > 25_000 {
        contenu = lignes[lignes.len() - 25_000..].join("\n");
    }
    if contenu.len() > 10 * 1024 * 1024 {
        let mut debut = contenu.len() - 9 * 1024 * 1024;
        while !contenu.is_char_boundary(debut) {
            debut += 1;
        }
        contenu = contenu[debut..].to_string();
    }
    let o = Options {
        methode: reqwest::Method::POST,
        entetes: vec![("Content-Type".into(), "application/x-www-form-urlencoded".into())],
        corps: Some(format!("content={}", encoder_formulaire(&contenu)).into_bytes()),
        essais: 1,
        ..Options::default()
    };
    let reponse: Value = match reseau.json("https://api.mclo.gs/1/log", &o).await {
        Ok(v) => v,
        Err(e) if e.statut.is_some() => {
            return Err(Erreur::new(tv("crashes.mclogs_refused", &[("status", &e.statut.unwrap_or(0).to_string())])));
        }
        Err(e) => return Err(Erreur::new(tv("crashes.mclo_gs_ne_repond_pas", &[("code", &e.message)]))),
    };
    if reponse.get("success") != Some(&Value::Bool(true)) {
        let erreur = reponse.get("error").and_then(Value::as_str).unwrap_or("");
        return Err(Erreur::new(tv("crashes.mclogs_refused_error", &[("error", erreur)])));
    }
    let champ = |c: &str| reponse.get(c).and_then(Value::as_str).unwrap_or("").to_string();
    Ok((champ("url"), champ("id")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;

    fn ids(d: &Diagnostic) -> Vec<&str> {
        d.problems.iter().map(|p| p.id).collect()
    }
    fn diag(texte: &str) -> Diagnostic {
        diagnostiquer(texte, &ContexteCrash::default())
    }

    #[test]
    fn dependance_fabric_absente() {
        let log = "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!\n\
                   A potential solution has been determined, this may resolve your problem:\n\t - Install fabric-api, any version.\nMore details:\n\
                   \t - Mod 'Mod Menu' (modmenu) 11.0.3 requires any version of fabric-api, which is missing!";
        let d = diag(log);
        assert_eq!(ids(&d), ["missing"]);
        assert_eq!(d.problems[0].lines, [4]);
        assert!(d.problems[0].actions.iter().any(|a| a.genre == "install" && a.slug.as_deref() == Some("fabric-api")));
        assert!(d.problems[0].actions.iter().any(|a| a.genre == "disable" && a.mod_id.as_deref() == Some("modmenu")));
    }

    #[test]
    fn mauvaises_versions_fabric() {
        let log = "\t - Mod 'Iris' (iris) 1.7.0+mc1.20.4 requires version 0.5.8 or later of mod 'Sodium' (sodium), but only the wrong version is present: 0.5.3!\n\
                   \t - Mod 'Sodium' (sodium) 0.5.8+mc1.20.4 requires version 1.20.4 of 'Minecraft' (minecraft), but only the wrong version is present: 1.20.1!";
        let d = diag(log);
        assert_eq!(ids(&d), ["version", "version"]);
        assert!(d.problems[0].title.contains("Sodium"));
        assert!(d.problems[1].title.contains("1.20.4"));
        assert!(d.problems[1].actions.iter().any(|a| a.genre == "disable" && a.mod_id.as_deref() == Some("sodium")));
    }

    #[test]
    fn incompatibles_fabric() {
        let d = diag("\t - Mod 'Sodium' (sodium) 0.6.0 is incompatible with any version of mod 'OptiFabric' (optifabric)");
        assert_eq!(ids(&d), ["incompatible"]);
        assert_eq!(d.problems[0].actions.len(), 1);
        assert_eq!(d.problems[0].actions[0].mod_id.as_deref(), Some("sodium"));
    }

    #[test]
    fn dependances_forge() {
        let log = "[main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:\n\
                   \tMod ID: 'geckolib', Requested by: 'mowziesmobs', Expected range: '[4.4.2,)', Actual version: '[MISSING]'\n\
                   \tMod ID: 'minecraft', Requested by: 'jei', Expected range: '[1.20.4]', Actual version: '1.20.1'";
        let d = diag(log);
        assert_eq!(ids(&d), ["missing", "version"]);
        assert!(d.problems[0].actions.iter().any(|a| a.genre == "install" && a.slug.as_deref() == Some("geckolib")));
        assert!(d.problems[1].title.contains("1.20.4"));
    }

    #[test]
    fn java_trop_ancien_ou_trop_recent() {
        let log = "Exception in thread \"main\" java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 52.0";
        let d = diagnostiquer(log, &ContexteCrash { java: Some(8), java_mode: "custom".into(), ..Default::default() });
        assert_eq!(ids(&d), ["java"]);
        assert!(d.problems[0].title.contains("21"));
        assert_eq!(d.problems[0].actions.iter().map(|a| a.genre).collect::<Vec<_>>(), ["settings"]);
        let d = diagnostiquer(
            "java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader",
            &ContexteCrash { java: Some(17), ..Default::default() },
        );
        assert_eq!(d.problems[0].id, "java");
        assert_eq!(d.problems[0].actions.iter().map(|a| a.genre).collect::<Vec<_>>(), ["mods"]);
    }

    #[test]
    fn memoire() {
        assert_eq!(
            ids(&diagnostiquer("java.lang.OutOfMemoryError: Java heap space", &ContexteCrash { ram: Some(2.0), ..Default::default() })),
            ["memory"]
        );
        assert_eq!(
            ids(&diag("Error occurred during initialization of VM\nCould not reserve enough space for 8388608KB object heap")),
            ["memory"]
        );
        assert_eq!(ids(&diag("# There is insufficient memory for the Java Runtime Environment to continue.")), ["memory"]);
        let d = diag("java.lang.OutOfMemoryError: Java heap space\njava.lang.OutOfMemoryError: Java heap space");
        assert_eq!((d.problems.len(), d.problems[0].lines.clone()), (1, vec![0, 1]));
    }

    #[test]
    fn pilote_graphique() {
        let log = "#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n\
                   #  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb1c2a4b3e, pid=12345, tid=6789\n#\n\
                   # JRE version: OpenJDK Runtime Environment Microsoft-9388422 (21.0.5+11) (build 21.0.5+11-LTS)\n# Problematic frame:\n# C  [atio6axx.dll+0x1a4b3e]";
        let d = diag(log);
        assert_eq!(ids(&d), ["gpu"]);
        assert!(d.problems[0].title.contains("AMD"));
        assert_eq!(d.problems[0].lines, [7]);
        assert_eq!(ids(&diag("[Render thread/ERROR]: GLFW error 65542: WGL: The driver does not appear to support OpenGL")), ["gpu"]);
    }

    #[test]
    fn mixin_et_jar_abime() {
        let m = diag(
            "org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered\nCaused by: Mixin apply for mod sodium failed sodium.mixins.json:core.MixinWindow",
        );
        assert_eq!(m.problems[0].id, "mixin");
        assert!(m.problems[0].actions.iter().any(|a| a.genre == "disable" && a.mod_id.as_deref() == Some("sodium")));
        let z = diag("java.util.zip.ZipException: zip END header not found\n\tat cristal-1.2.0.jar");
        assert_eq!(z.problems[0].id, "corrupt");
        assert!(z.problems[0].title.contains("cristal-1.2.0.jar"));
    }

    #[test]
    fn suspects_et_inconnue() {
        let rapport = "---- Minecraft Crash Report ----\nDescription: Rendering overlay\n\n\
                       java.lang.NullPointerException: Cannot invoke \"Object.hashCode()\" because \"key\" is null\n\tat java.base/java.util.HashMap.get(HashMap.java:556)\n\n\
                       Suspected Mods: Sodium (sodium), Iris (iris)";
        let d = diag(rapport);
        assert_eq!(
            d.suspects,
            [Suspect { name: "Sodium".into(), mod_id: "sodium".into() }, Suspect { name: "Iris".into(), mod_id: "iris".into() }]
        );
        assert_eq!(d.problems[0].id, "suspect");
        assert_eq!(d.problems[0].actions.iter().map(|a| a.mod_id.as_deref().unwrap()).collect::<Vec<_>>(), ["sodium", "iris"]);
        let d = diag("Description: Ticking entity\n\njava.lang.IllegalStateException: bizarre\nSuspected Mods: NONE");
        assert!(d.suspects.is_empty());
        assert_eq!(d.problems[0].id, "unknown");
        assert!(d.problems[0].text.contains("IllegalStateException"));
        assert_eq!(d.problems[0].lines, [2, 0]);
    }

    #[test]
    fn noms_de_fichiers_refuses() {
        let (jeu, inst) = (Path::new("C:/jeu"), Path::new("C:/instance"));
        let d = Dossiers { jeu, instance: inst };
        assert!(
            fichier_crash(&d, "report", "crash-2026-11-09_12.00.00-client.txt").unwrap().ends_with("crash-2026-11-09_12.00.00-client.txt")
        );
        assert!(fichier_crash(&d, "report", "../crash-x.txt").is_err());
        assert!(fichier_crash(&d, "report", "options.txt").is_err());
        assert!(fichier_crash(&d, "jvm", "hs_err_pidabc.log").is_err());
        assert!(fichier_crash(&d, "autre", "crash-x.txt").is_err());
    }

    #[test]
    fn jetons_masques() {
        let jwt = format!("eyJ{}.{}.{}", "a".repeat(20), "b".repeat(20), "c".repeat(20));
        let s = nettoyer(&format!("--accessToken secret123 --uuid abcd {jwt}"));
        assert!(!s.contains("secret123") && !s.contains("abcd") && !s.contains(&jwt));
        assert_eq!(encoder_formulaire("a b&é"), "a+b%26%C3%A9");
    }

    #[test]
    fn logs_gardes_et_listes() {
        let d = Dossier::nouveau("crashes");
        let (jeu, inst) = (d.0.join("jeu"), d.0.join("inst"));
        d.ecrire("jeu/crash-reports/crash-2026-01-01_10.00.00-client.txt", "x");
        d.ecrire("jeu/hs_err_pid42.log", "y");
        d.ecrire("jeu/options.txt", "z");
        for n in 0..16 {
            d.ecrire(&format!("inst/crash-logs/launcher-2000-01-{:02}_00-00-00.log", n + 1), "ancien");
        }
        let lignes = [LigneJeu::new("12:00:00".into(), "main/ERROR", "boum")];
        let f = garder_log(&inst, &lignes, Some(1)).unwrap();
        let texte = std::fs::read_to_string(inst.join("crash-logs").join(&f)).unwrap();
        assert!(texte.starts_with("[12:00:00] [main/ERROR]: boum\n"), "{texte}");
        let l = lister(&Dossiers { jeu: &jeu, instance: &inst });
        assert_eq!(l.iter().filter(|c| c.source == "log").count(), 15);
        assert_eq!(l.iter().filter(|c| c.source != "log").count(), 2);
        assert!(l.iter().any(|c| c.file == f));
        let (t, tronque) = lire_texte(&jeu.join("hs_err_pid42.log")).unwrap();
        assert_eq!((t.as_str(), tronque), ("y", false));
    }
}
