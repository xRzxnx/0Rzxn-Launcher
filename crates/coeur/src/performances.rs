//! Arguments Java selon la version de Java et mémoire conseillée, comme core/performance.js.
//! Le Pack Performances (mods Modrinth) arrive avec le contenu (R4).

use regex::Regex;
use std::sync::LazyLock;

pub const PRESETS: [&str; 4] = ["auto", "g1", "zgc", "none"];

/// G1 réglé pour un jeu : pauses courtes et jeune génération plus grande (les objets du jeu vivent très peu).
pub const G1_ARGS: [&str; 8] = [
    "-XX:+UseG1GC",
    "-XX:MaxGCPauseMillis=37",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:G1NewSizePercent=23",
    "-XX:G1ReservePercent=20",
    "-XX:G1HeapRegionSize=16M",
    "-XX:+ParallelRefProcEnabled",
    "-XX:+DisableExplicitGC",
];
/// Communs à G1 et ZGC : tas touché dès le démarrage, pas de fichier de statistiques écrit pendant les pauses.
pub const COMMON_ARGS: [&str; 2] = ["-XX:+AlwaysPreTouch", "-XX:+PerfDisableSharedMem"];
/// En dessous, G1 fait mieux sur un client : ZGC prend du processeur au jeu et veut de la marge de mémoire.
pub const ZGC_MIN_CPUS: usize = 8;
pub const ZGC_MIN_RAM: f64 = 6.0;

/// ZGC générationnel : option à passer en Java 21 ; c'est le mode par défaut (et unique) depuis Java 23.
pub fn zgc_args(java: u32) -> Vec<&'static str> {
    if java >= 25 {
        vec!["-XX:+UseZGC", "-XX:+UseCompactObjectHeaders"]
    } else if java >= 23 {
        vec!["-XX:+UseZGC"]
    } else {
        vec!["-XX:+UseZGC", "-XX:+ZGenerational"]
    }
}

/// L'utilisateur choisit déjà son ramasse-miettes dans ses propres arguments.
pub fn choisi_par_l_utilisateur(jvm_args: &str) -> bool {
    static GC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-XX:\+Use\w*GC\b").unwrap());
    GC.is_match(jvm_args)
}

/// Cœurs logiques du PC, comme os.cpus().length.
pub fn coeurs_logiques() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// Ramasse-miettes réellement utilisé : « g1 », « zgc » ou « none » (celui de Java par défaut).
pub fn choisir_gc(preset: &str, java: u32, ram_go: f64, cpus: usize, jvm_args: &str) -> &'static str {
    if preset == "none" || choisi_par_l_utilisateur(jvm_args) {
        return "none";
    }
    // ZGC travaille en parallèle du jeu : il lui faut Java 21 (générationnel), assez de cœurs et un tas assez grand.
    let zgc_ok = java >= 21;
    match preset {
        "zgc" => {
            if zgc_ok {
                "zgc"
            } else {
                "g1"
            }
        }
        "g1" => "g1",
        _ if zgc_ok && cpus >= ZGC_MIN_CPUS && ram_go >= ZGC_MIN_RAM => "zgc",
        _ => "g1",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArgumentsJvm {
    pub gc: &'static str,
    pub args: Vec<String>,
}

/// Arguments de mémoire et de ramasse-miettes, placés avant ceux de l'utilisateur (qui gardent le dernier mot).
pub fn arguments_jvm(preset: &str, java: u32, ram_go: f64, jvm_args: &str, cpus: usize) -> ArgumentsJvm {
    let memoire = (ram_go * 1024.0).round() as i64;
    let gc = choisir_gc(preset, java, ram_go, cpus, jvm_args);
    if preset == "none" {
        return ArgumentsJvm { gc, args: vec![format!("-Xmx{memoire}M"), format!("-Xms{}M", memoire.min(1024))] };
    }
    // Tas réservé d'un coup : pas d'agrandissements pendant la partie.
    let mut args = vec![format!("-Xmx{memoire}M"), format!("-Xms{memoire}M")];
    let suite: Vec<&str> = match gc {
        "zgc" => zgc_args(java).into_iter().chain(COMMON_ARGS).collect(),
        "g1" => G1_ARGS.into_iter().chain(COMMON_ARGS).collect(),
        _ => vec![],
    };
    args.extend(suite.into_iter().map(String::from));
    ArgumentsJvm { gc, args }
}

/// Part maximale de la RAM du PC donnée au jeu ; une carte intégrée prend sa mémoire dans la RAM : on en laisse plus.
const PART_RAM: f64 = 0.6;
const PART_RAM_INTEGREE: f64 = 0.5;

/// Versions d'avant 1.13 : monde et textures bien plus légers.
pub fn version_ancienne(version: &str) -> bool {
    static SORTIE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^1\.(\d+)").unwrap());
    static PREHISTOIRE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(a|b|c|rd|inf)").unwrap());
    match SORTIE.captures(version) {
        Some(c) => c[1].parse::<u32>().is_ok_and(|n| n < 13),
        None => PREHISTOIRE.is_match(version),
    }
}

/// Mémoire utile en Go. min : en dessous, le jeu manque de mémoire ; low à high : zone idéale ; cap : limite du PC.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct GuideRam {
    pub min: f64,
    pub low: f64,
    pub high: f64,
    pub cap: f64,
    pub limited: bool,
    pub ideal: f64,
}

pub struct Besoin<'a> {
    pub loader: &'a str,
    pub version: &'a str,
    pub mods: u32,
    pub shaders: u32,
    pub zgc: bool,
    pub total_go: f64,
    pub integree: bool,
}

pub fn guide_ram(b: &Besoin) -> GuideRam {
    let (mut low, mut high) = if b.loader == "vanilla" {
        if version_ancienne(b.version) { (2.0, 3.0) } else { (3.0, 4.0) }
    } else if b.mods > 200 {
        (10.0, 12.0)
    } else if b.mods > 120 {
        (8.0, 10.0)
    } else if b.mods > 50 {
        (6.0, 8.0)
    } else {
        (4.0, 6.0)
    };
    // ZGC prend 10 à 15 % de mémoire en plus.
    let extra = f64::from(u8::from(b.shaders > 0) + u8::from(b.zgc));
    let part = if b.integree { PART_RAM_INTEGREE } else { PART_RAM };
    let cap = 2f64.max((b.total_go.round() * part * 2.0).floor() / 2.0);
    let limited = cap < high + extra;
    low = (low + extra).min(cap);
    high = (high + extra).min(cap);
    GuideRam { min: 1.5f64.max(low - 1.0), low, high, cap, limited, ideal: high.min(((low + high) / 2.0).ceil()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choix_automatique() {
        assert_eq!(choisir_gc("auto", 21, 8.0, 16, ""), "zgc");
        assert_eq!(choisir_gc("auto", 21, 8.0, 4, ""), "g1");
        assert_eq!(choisir_gc("auto", 21, 4.0, 16, ""), "g1");
        assert_eq!(choisir_gc("auto", 17, 8.0, 16, ""), "g1");
    }

    #[test]
    fn choix_impose() {
        assert_eq!(choisir_gc("zgc", 21, 2.0, 2, ""), "zgc");
        assert_eq!(choisir_gc("zgc", 17, 8.0, 16, ""), "g1");
        assert_eq!(choisir_gc("g1", 25, 16.0, 32, ""), "g1");
        assert_eq!(choisir_gc("none", 21, 8.0, 16, ""), "none");
        assert_eq!(choisir_gc("auto", 21, 8.0, 16, "-XX:+UseShenandoahGC"), "none");
        assert!(!choisi_par_l_utilisateur("-Xss2M"));
    }

    #[test]
    fn zgc_selon_java() {
        assert_eq!(zgc_args(21), ["-XX:+UseZGC", "-XX:+ZGenerational"]);
        assert_eq!(zgc_args(23), ["-XX:+UseZGC"]);
        assert_eq!(zgc_args(25), ["-XX:+UseZGC", "-XX:+UseCompactObjectHeaders"]);
    }

    #[test]
    fn tas_et_ramasse_miettes() {
        let g1 = arguments_jvm("g1", 17, 4.0, "", 8);
        assert_eq!(g1.gc, "g1");
        assert_eq!(g1.args[..3], ["-Xmx4096M", "-Xms4096M", "-XX:+UseG1GC"]);
        assert!(g1.args.iter().any(|a| a == "-XX:+AlwaysPreTouch"));

        let zgc = arguments_jvm("auto", 25, 8.0, "", 16);
        assert_eq!(zgc.gc, "zgc");
        assert!(zgc.args.iter().any(|a| a == "-XX:+UseCompactObjectHeaders"));
        assert!(!zgc.args.iter().any(|a| a == "-XX:+UseG1GC"));

        assert_eq!(arguments_jvm("none", 21, 6.0, "", 8).args, ["-Xmx6144M", "-Xms1024M"]);
        assert_eq!(arguments_jvm("none", 8, 0.5, "", 8).args, ["-Xmx512M", "-Xms512M"]);
        assert_eq!(
            arguments_jvm("auto", 21, 3.5, "-XX:+UseParallelGC", 8),
            ArgumentsJvm { gc: "none", args: vec!["-Xmx3584M".into(), "-Xms3584M".into()] }
        );
    }

    fn besoin(loader: &'static str, version: &'static str, mods: u32, total_go: f64) -> Besoin<'static> {
        Besoin { loader, version, mods, shaders: 0, zgc: false, total_go, integree: false }
    }

    #[test]
    fn guide_selon_l_instance() {
        let g = |l, v, m| guide_ram(&besoin(l, v, m, 32.0));
        assert_eq!(g("vanilla", "1.21.4", 0), GuideRam { min: 2.0, low: 3.0, high: 4.0, cap: 19.0, limited: false, ideal: 4.0 });
        assert_eq!(g("vanilla", "1.8.9", 0).high, 3.0);
        assert_eq!(g("vanilla", "b1.7.3", 0).high, 3.0);
        assert_eq!(g("fabric", "", 20).high, 6.0);
        assert_eq!(g("fabric", "", 80).high, 8.0);
        assert_eq!(g("forge", "", 150).high, 10.0);
        assert_eq!(g("neoforge", "", 250).high, 12.0);
        let lourd = guide_ram(&Besoin { shaders: 2, zgc: true, ..besoin("fabric", "", 80, 32.0) });
        assert_eq!(lourd, GuideRam { min: 7.0, low: 8.0, high: 10.0, cap: 19.0, limited: false, ideal: 9.0 });
    }

    #[test]
    fn guide_selon_le_pc() {
        let petit = guide_ram(&besoin("forge", "", 150, 8.0));
        assert_eq!((petit.cap, petit.limited, petit.high, petit.low), (4.5, true, 4.5, 4.5));
        assert_eq!(guide_ram(&Besoin { integree: true, ..besoin("forge", "", 150, 8.0) }).cap, 4.0);
        let minuscule = guide_ram(&besoin("vanilla", "1.21", 0, 2.0));
        assert_eq!((minuscule.cap, minuscule.min), (2.0, 1.5));
    }
}
