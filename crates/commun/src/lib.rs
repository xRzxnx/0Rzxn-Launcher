//! Types partagés par le moteur (app) et l'interface (WebAssembly), et traductions.
//! Un même type des deux côtés : un échange qui ne correspond plus ne compile pas.

pub mod decor;
pub mod i18n;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const LOADERS: [&str; 5] = ["vanilla", "fabric", "quilt", "forge", "neoforge"];

pub fn loader_name(loader: &str) -> &'static str {
    match loader {
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => "Vanilla",
    }
}

/// Réglages d'une instance, et réglages par défaut des nouvelles instances (DEFAULT_SETTINGS de core/instances.js).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Reglages {
    /// Mémoire en Go (0,5 à 64).
    pub ram: f64,
    /// auto | custom
    pub java: String,
    pub java_path: String,
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
    pub jvm_args: String,
    pub low_ram_warning: bool,
    /// keep | minimize | hide
    pub after_launch: String,
    /// auto | g1 | zgc | none
    pub jvm_preset: String,
    /// normal | above
    pub priority: String,
    pub backup_auto: bool,
    /// never | hardcore | always
    pub backup_launch: String,
    pub backup_keep: u32,
}

impl Default for Reglages {
    fn default() -> Self {
        Self {
            ram: 4.0,
            java: "auto".into(),
            java_path: String::new(),
            width: 1280,
            height: 720,
            fullscreen: false,
            jvm_args: String::new(),
            low_ram_warning: true,
            after_launch: "minimize".into(),
            jvm_preset: "auto".into(),
            priority: "normal".into(),
            backup_auto: true,
            backup_launch: "hardcore".into(),
            backup_keep: 5,
        }
    }
}

/// Téléchargements simultanés, au total et par serveur.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitesTelechargement {
    pub concurrency: u32,
    pub per_host: u32,
}

/// Réglages du launcher lui-même (Paramètres › Launcher), LAUNCHER_DEFAULTS de services/settings.js.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReglagesLauncher {
    pub language: String,
    pub accent: String,
    pub discord: bool,
    pub discord_show_name: bool,
    pub tray: bool,
    pub close_to_tray: bool,
    pub light_mode: bool,
    pub gpu_high_performance: bool,
    pub auto_update: bool,
    pub update_channel: String,
    pub downloads: LimitesTelechargement,
}

impl Default for ReglagesLauncher {
    fn default() -> Self {
        Self {
            language: "auto".into(),
            accent: "violet".into(),
            discord: false,
            discord_show_name: true,
            tray: true,
            close_to_tray: false,
            light_mode: true,
            gpu_high_performance: false,
            auto_update: true,
            update_channel: "stable".into(),
            downloads: LimitesTelechargement { concurrency: 16, per_host: 8 },
        }
    }
}

/// Dernier lancement d'une instance (launcher.db) : préparation, jusqu'au menu, pic de mémoire.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DernierLancement {
    pub started_at: i64,
    pub prepare_ms: Option<i64>,
    pub menu_ms: Option<i64>,
    pub peak_memory: Option<i64>,
}

/// Temps de jeu suivi : minutes par jour (« 2026-11-03 »), nombre de parties, plus longue partie.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub days: BTreeMap<String, f64>,
    pub sessions: u32,
    pub longest: f64,
    pub since: Option<i64>,
}

/// Fond choisi pour l'instance : sunset | night | forest | image.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fond {
    pub kind: String,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub dim: f64,
}

/// Instance telle que l'interface la reçoit : instance.json + ce que le moteur calcule.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: String,
    #[serde(default = "icone_par_defaut")]
    pub icon: String,
    pub version: String,
    #[serde(default = "vanilla")]
    pub loader: String,
    #[serde(default)]
    pub loader_version: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub seed: Option<u32>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub last_played_at: Option<i64>,
    #[serde(default)]
    pub playtime: f64,
    #[serde(default)]
    pub settings: Reglages,
    #[serde(default)]
    pub stats: Option<Stats>,
    #[serde(default)]
    pub background: Option<Fond>,
    #[serde(default)]
    pub imported_from: Option<serde_json::Value>,
    // Calculés par le moteur, absents d'instance.json :
    #[serde(default)]
    pub installed: bool,
    /// Version de Java demandée par le fichier de version de Mojang, s'il est installé.
    #[serde(default)]
    pub java_major: Option<u32>,
    /// Mods actifs (fichiers .jar du dossier mods).
    #[serde(default)]
    pub mods_actifs: Option<u32>,
    /// Dernier lancement noté dans launcher.db.
    #[serde(default)]
    pub last_launch: Option<DernierLancement>,
}

fn icone_par_defaut() -> String {
    "grass".into()
}
fn vanilla() -> String {
    "vanilla".into()
}

/// Compte, sans aucun jeton : l'interface n'en reçoit jamais.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Compte {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
}

/// Partie en cours ou en préparation (launch:status, launch:progress).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Partie {
    pub instance_id: String,
    /// preparing | running
    pub phase: String,
    pub step: usize,
    pub done: u64,
    pub total: u64,
    pub prepare_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepare_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu_ms: Option<i64>,
}

/// Mémoire et processeur du jeu, toutes les 2 s (launch:metrics).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MesuresJeu {
    pub instance_id: String,
    pub memory: Option<u64>,
    pub peak: Option<u64>,
    pub cpu: Option<u32>,
    pub allocated: u64,
}

/// Tout ce que l'accueil charge au démarrage.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Demarrage {
    pub app_version: String,
    pub lang: String,
    pub platform: String,
    pub instances: Vec<Instance>,
    pub accounts: Vec<Compte>,
    pub active_account_id: Option<String>,
    pub selected_id: Option<String>,
    pub collapsed_groups: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_json_reel_se_lit() {
        let json = r#"{"id":"1-21-11-mods","name":"1.21.11 mods","icon":"grass","version":"1.21.11",
            "loader":"fabric","loaderVersion":"0.19.5","group":null,"seed":67,"createdAt":1793818782378,
            "lastPlayedAt":1794616526671,"playtime":1531,"settings":{"ram":10,"java":"auto","javaPath":"",
            "width":1280,"fullscreen":true},"stats":{"days":{"2026-11-03":42},"sessions":3,"longest":61}}"#;
        let i: Instance = serde_json::from_str(json).unwrap();
        assert_eq!(i.loader_version.as_deref(), Some("0.19.5"));
        assert_eq!(i.settings.ram, 10.0);
        assert_eq!(i.stats.unwrap().days["2026-11-03"], 42.0);
        assert!(!i.installed);
    }

    #[test]
    fn instance_minimale() {
        let i: Instance = serde_json::from_str(r#"{"id":"a","name":"A","version":"1.8.9"}"#).unwrap();
        assert_eq!((i.icon.as_str(), i.loader.as_str(), i.settings.ram), ("grass", "vanilla", 4.0));
    }
}
