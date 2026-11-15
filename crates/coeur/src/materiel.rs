//! Composants du PC : mémoire, processeur et carte graphique, lus une fois puis gardés, comme core/hardware.js.
//! Windows : registre et API du système (plus de PowerShell). Linux : /proc. macOS : sysctl. Les cartes graphiques ne
//! sont listées que sous Windows (comme la version Electron).

use crate::i18n::{go, t, tv};
use crate::mesures::memoire_totale;
use regex::Regex;
use serde::Serialize;
use std::sync::{LazyLock, OnceLock};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Carte {
    pub name: String,
    pub integrated: bool,
}

/// Puce intégrée au processeur ? D'après le fabricant (PCI) et le nom.
pub fn integree(nom: &str, pnp: &str) -> bool {
    static INTEL_ARC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Arc\(TM\) [AB]\d|Arc [AB]\d").unwrap());
    static AMD_APU: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Radeon\(TM\)( \d+M)? Graphics|Radeon Graphics|Vega \d+ Graphics").unwrap());
    let haut = pnp.to_uppercase();
    let fabricant = haut.find("VEN_").and_then(|i| haut.get(i + 4..i + 8));
    match fabricant {
        Some("8086") => !INTEL_ARC.is_match(nom),
        Some("1002") => AMD_APU.is_match(nom),
        _ => false,
    }
}

/// « NVIDIA GeForce RTX 3060 » → « RTX 3060 ».
pub fn nom_court(nom: &str) -> String {
    static MARQUES: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\((R|TM)\)|\b(NVIDIA|GeForce|AMD|ATI|Intel|Laptop GPU|Graphics)\b").unwrap());
    MARQUES.replace_all(nom, "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// La carte active : une carte dédiée passe avant la puce du processeur.
pub fn carte_principale(cartes: &[Carte]) -> Option<&Carte> {
    cartes.iter().find(|c| !c.integrated).or(cartes.first())
}

/// Cartes graphiques physiques (les écrans virtuels et le bureau à distance sont ignorés).
pub fn cartes() -> Vec<Carte> {
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let classe = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
        let Ok(c) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(classe) else { return vec![] };
        let mut l = vec![];
        for nom in c.enum_keys().flatten().filter(|n| n.bytes().all(|b| b.is_ascii_digit())) {
            let Ok(k) = c.open_subkey(&nom) else { continue };
            let id: String = k.get_value("MatchingDeviceId").unwrap_or_default();
            let desc: String = k.get_value("DriverDesc").unwrap_or_default();
            if id.to_lowercase().starts_with("pci\\") && !desc.is_empty() {
                l.push(Carte { integrated: integree(desc.trim(), &id), name: desc.trim().into() });
            }
        }
        l
    }
    #[cfg(not(windows))]
    vec![]
}

/// Linux : couples uniques (processeur physique, cœur) de /proc/cpuinfo ; None sans ces champs.
pub fn coeurs_cpuinfo(cpuinfo: &str) -> Option<usize> {
    let mut paires = std::collections::HashSet::new();
    for bloc in cpuinfo.split("\n\n") {
        let champ = |n: &str| {
            bloc.lines().find_map(|l| l.strip_prefix(n).and_then(|r| r.trim_start().strip_prefix(':')).map(|v| v.trim().to_string()))
        };
        if let (Some(p), Some(c)) = (champ("physical id"), champ("core id")) {
            paires.insert((p, c));
        }
    }
    (!paires.is_empty()).then_some(paires.len())
}

/// Cœurs physiques (os.cpus() compte les cœurs logiques).
pub fn coeurs_physiques() -> Option<usize> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{
            GetLogicalProcessorInformation, RelationProcessorCore, SYSTEM_LOGICAL_PROCESSOR_INFORMATION,
        };
        let mut taille = 0u32;
        unsafe { GetLogicalProcessorInformation(std::ptr::null_mut(), &mut taille) };
        let n = taille as usize / size_of::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION>();
        if n == 0 {
            return None;
        }
        let mut infos: Vec<SYSTEM_LOGICAL_PROCESSOR_INFORMATION> = Vec::with_capacity(n);
        if unsafe { GetLogicalProcessorInformation(infos.as_mut_ptr(), &mut taille) } == 0 {
            return None;
        }
        unsafe { infos.set_len(taille as usize / size_of::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION>()) };
        Some(infos.iter().filter(|i| i.Relationship == RelationProcessorCore).count()).filter(|n| *n > 0)
    }
    #[cfg(target_os = "linux")]
    {
        coeurs_cpuinfo(&std::fs::read_to_string("/proc/cpuinfo").ok()?)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let o = std::process::Command::new("/usr/sbin/sysctl").args(["-n", "hw.physicalcpu"]).output().ok()?;
        String::from_utf8_lossy(&o.stdout).trim().parse().ok().filter(|n: &usize| *n > 0)
    }
}

/// Nom du processeur.
pub fn processeur() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let k = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0").ok()?;
        k.get_value::<String, _>("ProcessorNameString").ok().map(|s| s.trim().to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let t = std::fs::read_to_string("/proc/cpuinfo").ok()?;
        t.lines().find_map(|l| l.strip_prefix("model name").and_then(|r| r.split_once(':')).map(|(_, v)| v.trim().to_string()))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let o = std::process::Command::new("/usr/sbin/sysctl").args(["-n", "machdep.cpu.brand_string"]).output().ok()?;
        Some(String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())
    }
}

struct Faits {
    total_go: f64,
    cpu: Option<String>,
    coeurs: Option<usize>,
    threads: usize,
    carte: Option<Carte>,
}

fn faits() -> &'static Faits {
    static F: OnceLock<Faits> = OnceLock::new();
    F.get_or_init(|| {
        let cartes = cartes();
        Faits {
            total_go: (memoire_totale() as f64 / 1024f64.powi(3)).round(),
            cpu: processeur(),
            coeurs: coeurs_physiques(),
            threads: crate::performances::coeurs_logiques(),
            carte: carte_principale(&cartes).cloned(),
        }
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Materiel {
    pub total_gb: f64,
    pub integrated: bool,
    pub summary: String,
    pub detail: String,
}

/// Seuls les faits sont gardés en mémoire : les libellés suivent la langue du moment.
pub fn materiel() -> Materiel {
    let f = faits();
    let coeurs = match f.coeurs {
        Some(c) => tv("hardware.urs", &[("cores", &c.to_string())]),
        None => tv("hardware.threads", &[("threads", &f.threads.to_string())]),
    };
    let carte = f.carte.as_ref().map(|c| if c.integrated { t("hardware.carte_integree") } else { nom_court(&c.name) });
    let summary = [Some(go(f.total_go)), Some(coeurs.clone()), carte].into_iter().flatten().collect::<Vec<_>>().join(" \u{b7} ");
    let ram = tv("hardware.ram_total", &[("ram", &go(f.total_go))]);
    let detail = [f.cpu.clone(), Some(coeurs), f.carte.as_ref().map(|c| c.name.clone()), Some(ram)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" \u{b7} ");
    Materiel { total_gb: f.total_go, integrated: f.carte.as_ref().is_some_and(|c| c.integrated), summary, detail }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cartes_et_noms() {
        assert!(integree("Intel(R) UHD Graphics 770", r"PCI\VEN_8086&DEV_4680"));
        assert!(!integree("Intel(R) Arc(TM) A770 Graphics", r"PCI\VEN_8086&DEV_56A0"));
        assert!(integree("AMD Radeon(TM) Graphics", r"PCI\VEN_1002&DEV_164E"));
        assert!(!integree("AMD Radeon RX 7800 XT", r"PCI\VEN_1002&DEV_747E"));
        assert!(!integree("NVIDIA GeForce RTX 3060", r"PCI\VEN_10DE&DEV_2504"));
        assert_eq!(nom_court("NVIDIA GeForce RTX 3060 Laptop GPU"), "RTX 3060");
        let l = [Carte { name: "UHD".into(), integrated: true }, Carte { name: "RTX".into(), integrated: false }];
        assert_eq!(carte_principale(&l).unwrap().name, "RTX");
        assert_eq!(
            coeurs_cpuinfo("physical id\t: 0\ncore id\t: 0\n\nphysical id\t: 0\ncore id\t: 0\n\nphysical id\t: 0\ncore id\t: 1\n"),
            Some(2)
        );
        assert_eq!(coeurs_cpuinfo("processor : 0"), None);
    }

    #[test]
    fn ce_pc() {
        let m = materiel();
        assert!(m.total_gb >= 1.0 && !m.summary.is_empty(), "{m:?}");
        if cfg!(windows) {
            assert!(coeurs_physiques().is_some() && processeur().is_some());
        }
    }
}
