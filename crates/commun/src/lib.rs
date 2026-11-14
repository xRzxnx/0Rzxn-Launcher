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

/// Réglages d'une instance (seuls ceux que l'accueil affiche pour l'instant).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Reglages {
    pub ram: f64,
    pub java: String,
    pub java_path: String,
}

impl Default for Reglages {
    fn default() -> Self {
        Self { ram: 4.0, java: "auto".into(), java_path: String::new() }
    }
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
