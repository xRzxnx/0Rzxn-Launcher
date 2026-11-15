//! Création, modification, copie et fond des instances, comme InstanceStore de core/instances.js.
//! La lecture (instances.rs) nettoie aussi ce que l'interface reçoit : « Reprendre », ensembles, Quick Play.

use crate::erreur::{Erreur, Resultat};
use crate::fichiers::{ecrire_json, lire_json};
use crate::i18n::t;
use crate::instances::{dossier, lire};
use commun::{Instance, Reglages};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

const ICONES: [&str; 6] = ["grass", "diamond", "stone", "netherrack", "sand", "end"];
const FONDS: [&str; 4] = ["sunset", "night", "forest", "image"];
const FOND_MAX: u64 = 10 * 1024 * 1024;
pub const STYLES_MENU: [&str; 3] = ["colonne", "centre", "minimal"];
const ENSEMBLES_MAX: usize = 20;
const MODS_PAR_ENSEMBLE: usize = 3000;

/// Nom de fichier d'une image de fond (« fond-<horodatage>.png »).
pub fn nom_de_fond(nom: &str) -> bool {
    let Some(reste) = nom.strip_prefix("fond-") else { return false };
    let Some((chiffres, ext)) = reste.split_once('.') else { return false };
    !chiffres.is_empty() && chiffres.bytes().all(|b| b.is_ascii_digit()) && ["png", "jpg", "webp"].contains(&ext)
}

/// Liste « Reprendre » : 5 entrées au plus, mondes et serveurs seulement.
pub fn nettoyer_recents(v: &Value) -> Vec<Value> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let genre = r.get("type").and_then(Value::as_str).filter(|g| *g == "singleplayer" || *g == "multiplayer")?;
            let id = r.get("id").and_then(Value::as_str).filter(|i| !i.is_empty() && i.chars().count() <= 260)?;
            let nom: String =
                r.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map_or(id.into(), |n| n.chars().take(100).collect());
            let quand = r.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            Some(json!({ "type": genre, "id": id, "name": nom, "at": quand }))
        })
        .take(5)
        .collect()
}

/// Quick Play existe depuis 1.20 (snapshot 23w14a) ; estimation d'après le nom de la version, pour l'interface.
pub fn quick_play_version(id: &str) -> bool {
    if let Some(reste) = id.strip_prefix("1.") {
        return reste.split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse::<u32>().ok()).is_some_and(|n| n >= 20);
    }
    let o = id.as_bytes();
    if o.len() >= 5 && o[..2].iter().all(u8::is_ascii_digit) && o[2] == b'w' && o[3..5].iter().all(u8::is_ascii_digit) {
        let (a, s): (u32, u32) = (id[..2].parse().unwrap_or(0), id[3..5].parse().unwrap_or(0));
        return a > 23 || (a == 23 && s >= 14);
    }
    // 26.1 et plus : numérotation par année.
    o.len() >= 4 && o[..2].iter().all(u8::is_ascii_digit) && o[2] == b'.' && o[3].is_ascii_digit()
}

fn nom_d_ensemble(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(30).collect()).unwrap_or_default()
}

/// Ensembles lus dans instance.json : forme, doublons, limites. Renvoie (ensembles, actif).
pub fn nettoyer_ensembles(ensembles: &Value, actif: &Value) -> (Vec<Value>, Option<String>) {
    let mut vus: Vec<String> = vec![];
    let mut l = vec![];
    for brut in ensembles.as_array().into_iter().flatten() {
        let nom = nom_d_ensemble(brut.get("name"));
        let Some(id) = brut.get("id").and_then(Value::as_str) else { continue };
        let id_ok = (4..=16).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        if nom.is_empty() || !id_ok || vus.iter().any(|v| v == id) || l.len() >= ENSEMBLES_MAX {
            continue;
        }
        vus.push(id.into());
        let mut mods: Vec<String> = vec![];
        for m in brut.get("mods").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !m.is_empty() && m.chars().count() <= 200 && !mods.iter().any(|x| x == m) && mods.len() < MODS_PAR_ENSEMBLE {
                mods.push(m.into());
            }
        }
        l.push(json!({ "id": id, "name": nom, "mods": mods }));
    }
    let actif = actif.as_str().filter(|a| vus.iter().any(|v| v == a)).map(String::from);
    (l, actif)
}

/// Réglage de l'écran titre Cristal : { style, card }, ou null.
pub fn options_menu(v: &Value) -> Value {
    if v.is_null() || v == &Value::Bool(false) {
        return Value::Null;
    }
    let style = v.get("style").and_then(Value::as_str).filter(|s| STYLES_MENU.contains(s)).unwrap_or("colonne");
    json!({ "style": style, "card": v.get("card") != Some(&Value::Bool(false)) })
}

/// « Survie Hardcore » → « survie-hardcore » (sans accents, 40 caractères au plus).
pub fn slug(nom: &str) -> String {
    let plie: String = crate::texte::plier(nom).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let s: String = plie.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-").chars().take(40).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "instance".into() } else { s }
}

/// Identifiant de dossier libre, tiré du nom (« survie », « survie-2 »…).
pub fn id_libre(racine: &Path, nom: &str) -> String {
    let base = slug(nom);
    let mut id = base.clone();
    let mut n = 2;
    while dossier(racine, &id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

fn verifier_loader(loader: &str, version: Option<&str>) -> Resultat<(String, Option<String>)> {
    if !commun::LOADERS.contains(&loader) {
        return Err(Erreur::new(t("instances.loader_de_mods_inconnu")));
    }
    if loader == "vanilla" {
        return Ok((loader.into(), None));
    }
    let ok = version.filter(|v| (1..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b)));
    ok.map(|v| (loader.into(), Some(v.into()))).ok_or_else(|| Erreur::new(t("instances.choisis_une_version_du_loader")))
}

fn groupe(v: &Value) -> Value {
    v.as_str()
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(30).collect::<String>())
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, Value::String)
}

fn compte(v: &Value) -> Value {
    v.as_str().filter(|s| !s.is_empty()).map_or(Value::Null, |s| Value::String(s.chars().take(80).collect()))
}

fn fichier(racine: &Path, id: &str) -> PathBuf {
    dossier(racine, id).join("instance.json")
}

fn introuvable() -> Erreur {
    Erreur::new(t("instances.instance_introuvable"))
}

fn lue(racine: &Path, id: &str) -> Resultat<Instance> {
    lire(racine, id).ok_or_else(introuvable)
}

fn graine() -> u32 {
    fastrand::u32(50..950)
}

/// Nouvelle instance : nom, icône, version, loader, groupe, compte ; réglages = réglages par défaut du launcher.
pub fn creer(racine: &Path, d: &Value, defauts: &Reglages) -> Resultat<Instance> {
    let nom: String = d.get("name").and_then(Value::as_str).unwrap_or("").trim().chars().take(40).collect();
    if nom.is_empty() {
        return Err(Erreur::new(t("instances.donne_un_nom_ton_instance")));
    }
    let version = d
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Erreur::new(t("instances.choisis_une_version_de_minecraft")))?;
    let (loader, loader_version) =
        verifier_loader(d.get("loader").and_then(Value::as_str).unwrap_or("vanilla"), d.get("loaderVersion").and_then(Value::as_str))?;
    let id = id_libre(racine, &nom);
    let icone = d.get("icon").and_then(Value::as_str).filter(|i| ICONES.contains(i)).unwrap_or("grass");
    let donnees = json!({
        "id": id, "name": nom, "icon": icone, "version": version, "loader": loader, "loaderVersion": loader_version,
        "group": groupe(d.get("group").unwrap_or(&Value::Null)), "accountId": compte(d.get("accountId").unwrap_or(&Value::Null)),
        "seed": graine(), "createdAt": crate::base::maintenant(), "lastPlayedAt": null, "playtime": 0,
        "settings": serde_json::to_value(defauts).unwrap_or_default(),
    });
    std::fs::create_dir_all(dossier(racine, &id).join("minecraft"))?;
    ecrire_json(&fichier(racine, &id), &donnees)?;
    lue(racine, &id)
}

fn modifier_brut(racine: &Path, id: &str, f: impl FnOnce(&mut Map<String, Value>) -> Resultat<()>) -> Resultat<()> {
    let mut m: Map<String, Value> = lire_json(&fichier(racine, id)).ok_or_else(introuvable)?;
    f(&mut m)?;
    Ok(ecrire_json(&fichier(racine, id), &m)?)
}

/// Fond de l'instance : { kind, dim, image? } ; null = décor par défaut.
fn nettoyer_fond(racine: &Path, id: &str, v: &Value) -> Resultat<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let genre =
        v.get("kind").and_then(Value::as_str).filter(|k| FONDS.contains(k)).ok_or_else(|| Erreur::new(t("instances.fond_inconnu")))?;
    let dim = v.get("dim").and_then(Value::as_f64).map_or(0.0, |d| d.round().clamp(0.0, 100.0));
    if genre != "image" {
        return Ok(json!({ "kind": genre, "dim": dim }));
    }
    let image = v.get("image").and_then(Value::as_str).filter(|i| nom_de_fond(i) && dossier(racine, id).join(i).is_file());
    let image = image.ok_or_else(|| Erreur::new(t("instances.image_de_fond_introuvable")))?;
    Ok(json!({ "kind": "image", "dim": dim, "image": image }))
}

/// Modifie l'instance (champs validés un par un) ; renvoie l'instance relue.
pub fn modifier(racine: &Path, id: &str, patch: &Value) -> Resultat<Instance> {
    modifier_brut(racine, id, |m| {
        if let Some(n) = patch.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) {
            m.insert("name".into(), n.chars().take(40).collect::<String>().into());
        }
        if let Some(i) = patch.get("icon").and_then(Value::as_str).filter(|i| ICONES.contains(i)) {
            m.insert("icon".into(), i.into());
        }
        if let Some(v) = patch.get("version").and_then(Value::as_str).filter(|v| !v.is_empty()) {
            m.insert("version".into(), v.into());
        }
        if let Some(l) = patch.get("loader") {
            let (loader, version) = verifier_loader(l.as_str().unwrap_or(""), patch.get("loaderVersion").and_then(Value::as_str))?;
            m.insert("loader".into(), loader.into());
            m.insert("loaderVersion".into(), version.map_or(Value::Null, Value::String));
        }
        if let Some(g) = patch.get("group") {
            m.insert("group".into(), groupe(g));
        }
        if let Some(c) = patch.get("accountId") {
            m.insert("accountId".into(), compte(c));
        }
        if let Some(f) = patch.get("background") {
            m.insert("background".into(), nettoyer_fond(racine, id, f)?);
        }
        if let Some(o) = patch.get("titleMenu") {
            m.insert("titleMenu".into(), options_menu(o));
        }
        if let Some(r) = patch.get("settings").filter(|r| r.is_object()) {
            let actuels = crate::reglages::nettoyer_instance(m.get("settings").unwrap_or(&Value::Null), &Reglages::default());
            m.insert("settings".into(), serde_json::to_value(crate::reglages::nettoyer_instance(r, &actuels)).unwrap_or_default());
        }
        Ok(())
    })?;
    if patch.get("background").is_some() {
        nettoyer_fonds(racine, id);
    }
    lue(racine, id)
}

/// Ensembles de mods (validés) et ensemble actif.
pub fn enregistrer_ensembles(racine: &Path, id: &str, ensembles: &Value, actif: &Value) -> Resultat<()> {
    let (l, a) = nettoyer_ensembles(ensembles, actif);
    modifier_brut(racine, id, |m| {
        m.insert("modSets".into(), Value::Array(l));
        m.insert("activeModSet".into(), a.map_or(Value::Null, Value::String));
        Ok(())
    })
}

/// Modpack d'origine : { projectId, versionId, name, version, icon, files } (null pour l'effacer).
pub fn changer_modpack(racine: &Path, id: &str, modpack: Value) -> Resultat<()> {
    modifier_brut(racine, id, |m| {
        m.insert("modpack".into(), modpack);
        Ok(())
    })
}

/// Instance importée d'un autre launcher : origine et temps de jeu repris.
pub fn marquer_importee(racine: &Path, id: &str, origine: Value, temps: f64, derniere: Option<i64>) -> Resultat<()> {
    modifier_brut(racine, id, |m| {
        m.insert("importedFrom".into(), origine);
        m.insert("playtime".into(), json!(temps.max(0.0).round()));
        m.insert("lastPlayedAt".into(), derniere.map_or(Value::Null, Value::from));
        Ok(())
    })
}

fn copier_dossier(de: &Path, vers: &Path, sauf: &dyn Fn(&Path) -> bool) -> std::io::Result<()> {
    std::fs::create_dir_all(vers)?;
    for e in std::fs::read_dir(de)?.flatten() {
        let p = e.path();
        if sauf(&p) {
            continue;
        }
        let cible = vers.join(e.file_name());
        let genre = e.file_type()?;
        if genre.is_dir() {
            copier_dossier(&p, &cible, sauf)?;
        } else if genre.is_file() {
            std::fs::copy(&p, &cible)?;
        }
    }
    Ok(())
}

/// Copie complète (mondes, options, packs…) sous un nouveau nom. Les natives sont réextraites au lancement.
pub fn dupliquer(racine: &Path, id: &str, nom: &str) -> Resultat<Instance> {
    let mut source: Map<String, Value> = lire_json(&fichier(racine, id)).ok_or_else(introuvable)?;
    let ancien = source.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let propre: String = nom.trim().chars().take(40).collect();
    let propre = if propre.is_empty() { format!("{ancien} (copie)").chars().take(40).collect() } else { propre };
    let copie = id_libre(racine, &propre);
    let (de, vers) = (dossier(racine, id), dossier(racine, &copie));
    let natives = de.join("natives");
    if let Err(e) = copier_dossier(&de, &vers, &|p| p == natives) {
        let _ = std::fs::remove_dir_all(&vers);
        return Err(e.into());
    }
    for c in ["stats", "importedFrom"] {
        source.remove(c);
    }
    source.insert("id".into(), copie.clone().into());
    source.insert("name".into(), propre.into());
    source.insert("seed".into(), graine().into());
    source.insert("createdAt".into(), crate::base::maintenant().into());
    source.insert("lastPlayedAt".into(), Value::Null);
    source.insert("playtime".into(), 0.into());
    ecrire_json(&fichier(racine, &copie), &source)?;
    lue(racine, &copie)
}

/// Format d'une image d'après ses premiers octets : l'extension seule ne prouve rien.
pub fn format_image(tete: &[u8]) -> Option<&'static str> {
    if tete.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("png");
    }
    if tete.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    (tete.len() >= 12 && &tete[..4] == b"RIFF" && &tete[8..12] == b"WEBP").then_some("webp")
}

/// Copie une image choisie dans le dossier de l'instance (png, jpeg ou webp, 10 Mo au plus). Renvoie son nom.
pub fn importer_fond(racine: &Path, id: &str, source: &Path) -> Resultat<String> {
    lue(racine, id)?;
    let invalide = || Erreur::new(t("instances.fichier_invalide"));
    if !source.is_absolute() {
        return Err(invalide());
    }
    let ext = source.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        return Err(Erreur::new(t("instances.choisis_une_image_png_jpeg")));
    }
    let m = std::fs::metadata(source).map_err(|_| invalide())?;
    if !m.is_file() {
        return Err(invalide());
    }
    if m.len() > FOND_MAX {
        return Err(Erreur::new(t("instances.cette_image_est_trop_lourde")));
    }
    let mut tete = [0u8; 16];
    let lus = std::io::Read::read(&mut std::fs::File::open(source)?, &mut tete)?;
    let format = format_image(&tete[..lus]).ok_or_else(|| Erreur::new(t("instances.ce_fichier_est_pas_une")))?;
    let nom = format!("fond-{}.{format}", crate::base::maintenant());
    std::fs::copy(source, dossier(racine, id).join(&nom))?;
    Ok(nom)
}

/// Chemin d'une image de fond de l'instance, ou None si le nom n'est pas valable.
pub fn fichier_fond(racine: &Path, id: &str, nom: &str) -> Option<PathBuf> {
    (crate::instances::id_valide(id) && nom_de_fond(nom)).then(|| dossier(racine, id).join(nom))
}

/// Supprime les images de fond qui ne sont plus utilisées.
pub fn nettoyer_fonds(racine: &Path, id: &str) {
    let utilisee =
        lire_json::<Value>(&fichier(racine, id)).and_then(|v| v.pointer("/background/image").and_then(Value::as_str).map(String::from));
    // Dossier illisible : rien à nettoyer.
    let Ok(it) = std::fs::read_dir(dossier(racine, id)) else { return };
    for e in it.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if nom_de_fond(&n) && Some(&n) != utilisee.as_ref() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;

    #[test]
    fn slugs_quick_play_et_recents() {
        assert_eq!(slug("Survie Hardcore !"), "survie-hardcore");
        assert_eq!(slug("Île été"), "ile-ete");
        assert_eq!(slug("???"), "instance");
        assert!(quick_play_version("1.20.1") && quick_play_version("1.21.11") && !quick_play_version("1.19.4"));
        assert!(quick_play_version("23w14a") && !quick_play_version("23w13a") && quick_play_version("24w01a"));
        assert!(quick_play_version("26.1") && !quick_play_version("b1.7.3"));
        let r = nettoyer_recents(
            &json!([{ "type": "singleplayer", "id": "Monde", "at": 5 }, { "type": "realms", "id": "x" }, { "type": "multiplayer", "id": "" }]),
        );
        assert_eq!(r, [json!({ "type": "singleplayer", "id": "Monde", "name": "Monde", "at": 5.0 })]);
        let (l, a) = nettoyer_ensembles(
            &json!([{ "id": "abcd", "name": "  PvP  ", "mods": ["m:a", "m:a", ""] }, { "id": "abcd", "name": "Double" }, { "id": "X!", "name": "Mauvais" }]),
            &json!("abcd"),
        );
        assert_eq!((l, a.as_deref()), (vec![json!({ "id": "abcd", "name": "PvP", "mods": ["m:a"] })], Some("abcd")));
        assert_eq!(options_menu(&json!({ "style": "bizarre", "card": false })), json!({ "style": "colonne", "card": false }));
        assert_eq!(options_menu(&Value::Null), Value::Null);
        assert_eq!(format_image(b"RIFF\0\0\0\0WEBPxx"), Some("webp"));
    }

    #[test]
    fn creer_modifier_dupliquer() {
        let d = Dossier::nouveau("gestion-instances");
        let defauts = Reglages { ram: 6.0, ..Reglages::default() };
        assert!(creer(&d.0, &json!({ "name": " ", "version": "1.21.11" }), &defauts).is_err());
        assert!(creer(&d.0, &json!({ "name": "A", "version": "1.21.11", "loader": "fabric" }), &defauts).is_err());
        let i = creer(&d.0, &json!({ "name": "Survie", "version": "1.21.11", "loader": "fabric", "loaderVersion": "0.17.2", "icon": "end", "group": "  Amis  " }), &defauts).unwrap();
        assert_eq!((i.id.as_str(), i.icon.as_str(), i.group.as_deref(), i.settings.ram), ("survie", "end", Some("Amis"), 6.0));
        assert_eq!(creer(&d.0, &json!({ "name": "Survie", "version": "1.21.11" }), &defauts).unwrap().id, "survie-2");

        let m = modifier(&d.0, "survie", &json!({ "name": "Survie 2", "loader": "vanilla", "settings": { "ram": 8, "jvmPreset": "zgc" }, "titleMenu": { "style": "centre" } })).unwrap();
        assert_eq!(
            (m.name.as_str(), m.loader.as_str(), m.loader_version.clone(), m.settings.ram, m.settings.jvm_preset.as_str()),
            ("Survie 2", "vanilla", None, 8.0, "zgc")
        );
        assert_eq!(m.title_menu, Some(json!({ "style": "centre", "card": true })));
        assert!(modifier(&d.0, "survie", &json!({ "background": { "kind": "image", "image": "fond-1.png" } })).is_err());

        d.ecrire("instances/survie/minecraft/saves/Monde/level.dat", "x");
        d.ecrire("instances/survie/natives/lwjgl.dll", "x");
        d.ecrire("instance.png", "\u{89}PNG");
        let c = dupliquer(&d.0, "survie", "").unwrap();
        assert_eq!((c.id.as_str(), c.name.as_str(), c.playtime), ("survie-2-copie", "Survie 2 (copie)", 0.0));
        assert!(d.0.join("instances/survie-2-copie/minecraft/saves/Monde/level.dat").is_file());
        assert!(!d.0.join("instances/survie-2-copie/natives").exists());
    }

    #[test]
    fn fonds_d_instance() {
        let d = Dossier::nouveau("fonds-instances");
        creer(&d.0, &json!({ "name": "A", "version": "1.21.11" }), &Reglages::default()).unwrap();
        let png = d.0.join("image.png");
        std::fs::write(&png, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).unwrap();
        let faux = d.0.join("faux.png");
        std::fs::write(&faux, b"pas une image").unwrap();
        assert!(importer_fond(&d.0, "a", &faux).is_err());
        let nom = importer_fond(&d.0, "a", &png).unwrap();
        let i = modifier(&d.0, "a", &json!({ "background": { "kind": "image", "image": nom, "dim": 140 } })).unwrap();
        assert_eq!(i.background.as_ref().map(|f| (f.kind.as_str(), f.dim)), Some(("image", 100.0)));
        assert!(fichier_fond(&d.0, "a", &nom).unwrap().is_file());
        assert!(fichier_fond(&d.0, "a", "../x.png").is_none());
        modifier(&d.0, "a", &json!({ "background": null })).unwrap();
        assert!(!d.0.join("instances/a").join(&nom).exists(), "image plus utilisée : retirée");
    }
}
