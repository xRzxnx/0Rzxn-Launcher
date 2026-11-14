//! settings.json : la partie que l'accueil utilise (instance choisie, groupes repliés, langue).

use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Interface {
    pub selected_id: Option<String>,
    pub collapsed_groups: Vec<String>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct Launcher {
    pub language: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct Reglages {
    pub ui: Interface,
    pub launcher: Launcher,
}

pub fn lire(donnees: &Path) -> Reglages {
    crate::lire_json(&donnees.join("settings.json")).unwrap_or_default()
}
