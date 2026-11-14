//! settings.json : réglages par défaut des instances, réglages du launcher et petites préférences d'interface
//! (services/settings.js). Chaque valeur lue est vérifiée : une valeur fausse garde la valeur précédente.

use crate::fichiers::{ecrire_json, lire_json};
use commun::i18n::LANGUES;
use commun::{LimitesTelechargement, Reglages, ReglagesLauncher};
use serde_json::{Map, Value};
use std::io;
use std::path::{Path, PathBuf};

const ACCENTS: [&str; 7] = ["violet", "bleu", "cyan", "vert", "ambre", "rouge", "rose"];

fn texte_parmi(v: &Value, choix: &[&str]) -> Option<String> {
    v.as_str().filter(|s| choix.contains(s)).map(str::to_string)
}

/// Entier JS (Number.isInteger) : 3 ou 3.0, pas 3.5 ni "3".
fn entier(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.is_finite()).map(|f| f as i64))
}

fn borne(v: &Value, min: i64, max: i64) -> Option<u32> {
    entier(v).map(|n| n.clamp(min, max) as u32)
}

/// sanitizeSettings de core/instances.js.
pub fn nettoyer_instance(entree: &Value, base: &Reglages) -> Reglages {
    let mut s = base.clone();
    if !entree.is_object() {
        return s;
    }
    let e = |k: &str| &entree[k];
    if let Some(r) = e("ram").as_f64() {
        s.ram = r.clamp(0.5, 64.0);
    }
    if let Some(v) = texte_parmi(e("java"), &["auto", "custom"]) {
        s.java = v;
    }
    if let Some(v) = e("javaPath").as_str() {
        s.java_path = v.trim().to_string();
    }
    if let Some(v) = entier(e("width")).filter(|&w| w >= 320) {
        s.width = v.min(u32::MAX as i64) as u32;
    }
    if let Some(v) = entier(e("height")).filter(|&h| h >= 240) {
        s.height = v.min(u32::MAX as i64) as u32;
    }
    if let Some(v) = e("fullscreen").as_bool() {
        s.fullscreen = v;
    }
    if let Some(v) = e("jvmArgs").as_str() {
        s.jvm_args = v.to_string();
    }
    if let Some(v) = e("lowRamWarning").as_bool() {
        s.low_ram_warning = v;
    }
    if let Some(v) = texte_parmi(e("afterLaunch"), &["keep", "minimize", "hide"]) {
        s.after_launch = v;
    }
    if let Some(v) = texte_parmi(e("jvmPreset"), &["auto", "g1", "zgc", "none"]) {
        s.jvm_preset = v;
    }
    if let Some(v) = texte_parmi(e("priority"), &["normal", "above"]) {
        s.priority = v;
    }
    if let Some(v) = e("backupAuto").as_bool() {
        s.backup_auto = v;
    }
    if let Some(v) = texte_parmi(e("backupLaunch"), &["never", "hardcore", "always"]) {
        s.backup_launch = v;
    }
    if let Some(v) = borne(e("backupKeep"), 1, 20) {
        s.backup_keep = v;
    }
    s
}

fn couleur_perso(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// sanitizeLauncher de services/settings.js.
pub fn nettoyer_launcher(entree: &Value, base: &ReglagesLauncher) -> ReglagesLauncher {
    let mut s = base.clone();
    if !entree.is_object() {
        return s;
    }
    let e = |k: &str| &entree[k];
    if let Some(l) = e("language").as_str().filter(|l| *l == "auto" || LANGUES.contains(l)) {
        s.language = l.to_string();
    }
    if let Some(a) = e("accent").as_str().filter(|a| ACCENTS.contains(a) || couleur_perso(a)) {
        s.accent = a.to_lowercase();
    }
    for (cle, champ) in [
        ("discord", &mut s.discord),
        ("discordShowName", &mut s.discord_show_name),
        ("tray", &mut s.tray),
        ("closeToTray", &mut s.close_to_tray),
        ("lightMode", &mut s.light_mode),
        ("gpuHighPerformance", &mut s.gpu_high_performance),
        ("autoUpdate", &mut s.auto_update),
    ] {
        if let Some(v) = e(cle).as_bool() {
            *champ = v;
        }
    }
    if let Some(v) = texte_parmi(e("updateChannel"), &["stable", "beta"]) {
        s.update_channel = v;
    }
    let d = e("downloads");
    if d.is_object() {
        s.downloads = LimitesTelechargement {
            concurrency: borne(&d["concurrency"], 1, 64).unwrap_or(s.downloads.concurrency),
            per_host: borne(&d["perHost"], 1, 32).unwrap_or(s.downloads.per_host),
        };
    }
    s
}

/// Préférences d'interface : instance choisie, groupes repliés, derniers rapports de crash vus.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Interface {
    pub selected_id: Option<String>,
    pub collapsed_groups: Vec<String>,
    pub crashes_seen_at: Option<f64>,
}

pub struct Magasin {
    fichier: PathBuf,
}

impl Magasin {
    pub fn new(donnees: &Path) -> Self {
        Self { fichier: donnees.join("settings.json") }
    }

    /// Tout le fichier (les clés inconnues sont gardées à l'écriture).
    fn lire(&self) -> Map<String, Value> {
        lire_json(&self.fichier).unwrap_or_default()
    }

    pub fn defauts(&self) -> Reglages {
        nettoyer_instance(&self.lire().get("defaults").cloned().unwrap_or(Value::Null), &Reglages::default())
    }

    pub fn changer_defauts(&self, patch: &Value) -> io::Result<Reglages> {
        let mut data = self.lire();
        let actuels = nettoyer_instance(data.get("defaults").unwrap_or(&Value::Null), &Reglages::default());
        let nouveaux = nettoyer_instance(patch, &actuels);
        data.insert("defaults".into(), serde_json::to_value(&nouveaux)?);
        ecrire_json(&self.fichier, &data)?;
        Ok(nouveaux)
    }

    pub fn launcher(&self) -> ReglagesLauncher {
        nettoyer_launcher(self.lire().get("launcher").unwrap_or(&Value::Null), &ReglagesLauncher::default())
    }

    pub fn changer_launcher(&self, patch: &Value) -> io::Result<ReglagesLauncher> {
        let mut data = self.lire();
        let actuels = nettoyer_launcher(data.get("launcher").unwrap_or(&Value::Null), &ReglagesLauncher::default());
        let nouveaux = nettoyer_launcher(patch, &actuels);
        data.insert("launcher".into(), serde_json::to_value(&nouveaux)?);
        ecrire_json(&self.fichier, &data)?;
        Ok(nouveaux)
    }

    pub fn interface(&self) -> Interface {
        let data = self.lire();
        let ui = data.get("ui").cloned().unwrap_or(Value::Null);
        Interface {
            selected_id: ui["selectedId"].as_str().map(str::to_string),
            collapsed_groups: ui["collapsedGroups"]
                .as_array()
                .map(|l| l.iter().filter_map(|g| g.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            crashes_seen_at: ui["crashesSeenAt"].as_f64(),
        }
    }

    /// setUi : seuls les champs présents et valides du patch changent ; les autres clés de « ui » restent.
    pub fn changer_interface(&self, patch: &Value) -> io::Result<Interface> {
        let mut data = self.lire();
        let mut ui = data.get("ui").and_then(Value::as_object).cloned().unwrap_or_default();
        match &patch["selectedId"] {
            v @ (Value::String(_) | Value::Null) if patch.get("selectedId").is_some() => {
                ui.insert("selectedId".into(), v.clone());
            }
            _ => {}
        }
        if let Some(groupes) = patch["collapsedGroups"].as_array() {
            let propres: Vec<Value> = groupes.iter().filter(|g| g.is_string()).take(100).cloned().collect();
            ui.insert("collapsedGroups".into(), Value::Array(propres));
        }
        if let Some(n) = patch["crashesSeenAt"].as_f64() {
            ui.insert("crashesSeenAt".into(), n.into());
        }
        data.insert("ui".into(), Value::Object(ui));
        ecrire_json(&self.fichier, &data)?;
        Ok(self.interface())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use serde_json::json;

    #[test]
    fn valeurs_fausses_ignorees() {
        let base = Reglages::default();
        let r = nettoyer_instance(
            &json!({ "ram": 100, "java": "x", "width": 200, "height": 1080.0, "backupKeep": 99, "afterLaunch": "hide" }),
            &base,
        );
        assert_eq!(
            (r.ram, r.java.as_str(), r.width, r.height, r.backup_keep, r.after_launch.as_str()),
            (64.0, "auto", 1280, 1080, 20, "hide")
        );
        assert_eq!(nettoyer_instance(&json!("pas un objet"), &base), base);

        let l = nettoyer_launcher(
            &json!({ "language": "de", "accent": "#ABCDEF", "tray": "oui", "downloads": { "concurrency": 100, "perHost": 2.5 } }),
            &ReglagesLauncher::default(),
        );
        assert_eq!((l.language.as_str(), l.accent.as_str(), l.tray), ("auto", "#abcdef", true));
        assert_eq!((l.downloads.concurrency, l.downloads.per_host), (64, 8));
    }

    #[test]
    fn ecritures_gardent_le_reste_du_fichier() {
        let d = Dossier::nouveau("reglages");
        d.ecrire("settings.json", r#"{"ui":{"selectedId":"a","autre":1},"defaults":{"ram":8},"inconnu":true}"#);
        let m = Magasin::new(&d.0);
        assert_eq!(m.defauts().ram, 8.0);
        m.changer_launcher(&json!({ "accent": "rose" })).unwrap();
        m.changer_interface(&json!({ "collapsedGroups": ["Fabric", 3], "selectedId": null })).unwrap();
        let brut: Value = crate::fichiers::lire_json(&d.0.join("settings.json")).unwrap();
        assert_eq!(brut["inconnu"], true);
        assert_eq!(brut["ui"]["autre"], 1);
        assert_eq!(brut["ui"]["selectedId"], Value::Null);
        assert_eq!(brut["launcher"]["accent"], "rose");
        assert_eq!(m.interface().collapsed_groups, ["Fabric"]);
    }
}
