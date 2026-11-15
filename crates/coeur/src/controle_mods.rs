//! Diagnostic des mods avant le lancement, comme core/mod-check.js : lit les métadonnées locales des jars (sans
//! réseau) et repère les dépendances absentes, les conflits déclarés et les doublons.

use crate::base::Base;
use crate::empreintes::{Etat, rappeler, retenir};
use crate::i18n::{langue, t, tv};
use crate::telechargement::sha1;
use crate::zip;
use commun::Instance;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const DESACTIVE: &str = ".disabled";
const IGNORES: [&str; 8] = ["java", "fabricloader", "fabric-loader", "quilt_loader", "quilt-loader", "forge", "neoforge", "minecraft"];
const PROFONDEUR_MAX: u32 = 2;

fn nom_loader(l: &str) -> &'static str {
    match l {
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => "",
    }
}

/// Formats de mods que chaque loader sait charger.
fn accepte(loader: &str) -> Option<&'static [&'static str]> {
    match loader {
        "fabric" => Some(&["fabric"]),
        "quilt" => Some(&["quilt", "fabric"]),
        "forge" => Some(&["forge"]),
        "neoforge" => Some(&["neoforge", "forge"]),
        _ => None,
    }
}

// ---------- Versions et plages ----------

/// Parties numériques d'une version (« 1.21.1-beta+x » → [1, 21, 1]).
pub fn parties(version: &str) -> Option<Vec<u64>> {
    static DEBUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+(?:\.\d+)*)").unwrap());
    let v = version.trim();
    let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
    DEBUT.captures(v).map(|c| c[1].split('.').map(|p| p.parse().unwrap_or(u64::MAX)).collect())
}

fn comparer(a: &[u64], b: &[u64]) -> Ordering {
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x.cmp(&y);
        }
    }
    Ordering::Equal
}

/// Plage de style Fabric/Quilt (texte ou liste de textes) : vrai, faux, ou None si le format n'est pas compris.
pub fn plage_fabric(plage: &Value, version: Option<&str>) -> Option<bool> {
    let v = parties(version?)?;
    let plages: Vec<&Value> = match plage {
        Value::Array(l) => l.iter().collect(),
        p => vec![p],
    };
    let mut inconnu = false;
    for r in plages {
        let r = r.as_str()?;
        for alt in r.split("||") {
            match tous(alt.trim(), &v) {
                Some(true) => return Some(true),
                None => inconnu = true,
                _ => {}
            }
        }
    }
    if inconnu { None } else { Some(false) }
}

fn tous(expression: &str, v: &[u64]) -> Option<bool> {
    if expression.is_empty() || expression == "*" {
        return Some(true);
    }
    let jetons: Vec<&str> = expression.split_whitespace().collect();
    let mut inconnu = false;
    let mut i = 0;
    while i < jetons.len() {
        let mut jeton = jetons[i].to_string();
        // « >= 1.2 » écrit avec une espace
        if [">=", "<=", ">", "<", "=", "~", "^"].contains(&jetons[i]) && i + 1 < jetons.len() {
            i += 1;
            jeton.push_str(jetons[i]);
        }
        match un(&jeton, v) {
            Some(false) => return Some(false),
            None => inconnu = true,
            _ => {}
        }
        i += 1;
    }
    if inconnu { None } else { Some(true) }
}

fn un(jeton: &str, v: &[u64]) -> Option<bool> {
    let op = [">=", "<=", ">", "<", "=", "~", "^"].into_iter().find(|o| jeton.starts_with(o)).unwrap_or("");
    let reste = &jeton[op.len()..];
    if reste.is_empty() {
        return None;
    }
    let brut = reste.split(['-', '+']).next().unwrap_or("");
    if ["*", "x", "X"].contains(&brut) {
        return Some(true);
    }
    if brut.ends_with(['x', 'X', '*']) {
        let prefixe = brut.trim_end_matches(['x', 'X', '*']).trim_end_matches('.');
        let p = parties(prefixe)?;
        if !op.is_empty() {
            return None;
        }
        return Some(comparer(&v[..p.len().min(v.len())], &p) == Ordering::Equal);
    }
    if brut.is_empty() || !brut.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let cible = parties(brut)?;
    let c = comparer(v, &cible);
    Some(match op {
        ">=" => c != Ordering::Less,
        ">" => c == Ordering::Greater,
        "<=" => c != Ordering::Greater,
        "<" => c == Ordering::Less,
        "" | "=" => c == Ordering::Equal,
        "~" => {
            let haut = if cible.len() > 1 { vec![cible[0], cible[1] + 1] } else { vec![cible[0] + 1] };
            c != Ordering::Less && comparer(v, &haut) == Ordering::Less
        }
        "^" => {
            if cible[0] == 0 {
                return None;
            }
            c != Ordering::Less && comparer(v, &[cible[0] + 1]) == Ordering::Less
        }
        _ => return None,
    })
}

/// Plage de style Maven (Forge/NeoForge) : « [1.20,1.21) », « [1.21.1] », unions séparées par des virgules.
pub fn plage_maven(plage: Option<&str>, version: Option<&str>) -> Option<bool> {
    static MOTIF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([\[(])\s*([^,\])\[(]*?)\s*(?:,\s*([^,\])\[(]*?)\s*)?([\])])").unwrap());
    let v = parties(version?)?;
    let plage = plage?;
    let reste: String = MOTIF.replace_all(plage, "").chars().filter(|c| !c.is_whitespace() && *c != ',').collect();
    if !reste.is_empty() {
        return None;
    }
    let mut une = false;
    let mut resultat = false;
    for c in MOTIF.captures_iter(plage) {
        une = true;
        let (ouvre, bas, haut, ferme) = (&c[1], c.get(2).map_or("", |m| m.as_str()), c.get(3).map(|m| m.as_str()), &c[4]);
        let Some(haut) = haut else {
            if comparer(&v, &parties(bas)?) == Ordering::Equal {
                resultat = true;
            }
            continue;
        };
        let b = if bas.is_empty() { vec![] } else { parties(bas)? };
        let h = if haut.is_empty() { None } else { Some(parties(haut)?) };
        let au_dessus =
            bas.is_empty() || if ouvre == "[" { comparer(&v, &b) != Ordering::Less } else { comparer(&v, &b) == Ordering::Greater };
        let en_dessous =
            h.as_ref().is_none_or(|h| if ferme == "]" { comparer(&v, h) != Ordering::Greater } else { comparer(&v, h) == Ordering::Less });
        if au_dessus && en_dessous {
            resultat = true;
        }
    }
    une.then_some(resultat)
}

// ---------- Lecture des jars ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Dependance {
    pub id: String,
    pub range: Value,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub maven: bool,
}

/// Ce qu'un jar déclare (gardé dans launcher.db sous « check:<loader> », même forme que la version Electron).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InfoJar {
    pub main_ids: Vec<String>,
    pub provided: Vec<String>,
    pub depends: Vec<Dependance>,
    pub breaks: Vec<Dependance>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub found: bool,
    pub made_for: Option<String>,
    pub optifine: bool,
}

fn sections_toml(texte: &str) -> Vec<(String, BTreeMap<String, String>)> {
    static TETE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\[\[\s*([^\]]+?)\s*\]\]").unwrap());
    static CLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))"#).unwrap());
    let mut sections: Vec<(String, BTreeMap<String, String>)> = vec![];
    let mut courante = false;
    for ligne in texte.lines() {
        if let Some(c) = TETE.captures(ligne) {
            sections.push((c[1].to_string(), BTreeMap::new()));
            courante = true;
            continue;
        }
        if ligne.trim_start().starts_with('[') {
            courante = false;
            continue;
        }
        if courante
            && let Some(c) = CLE.captures(ligne)
            && let Some(s) = sections.last_mut()
        {
            let v = c.get(2).or(c.get(3)).or(c.get(4)).map_or("", |m| m.as_str());
            s.1.insert(c[1].to_string(), v.to_string());
        }
    }
    sections
}

struct Jar<'a> {
    octets: &'a [u8],
    entrees: Vec<zip::Entree>,
}

impl Jar<'_> {
    fn lire(&self, nom: &str) -> Option<Vec<u8>> {
        self.entrees.iter().find(|e| e.name == nom).and_then(|e| zip::lire_entree(self.octets, e).ok())
    }
    fn json(&self, nom: &str) -> Option<Value> {
        serde_json::from_slice(&self.lire(nom)?).ok()
    }
}

/// Fabric : objet { id: plage } ; Quilt : tableau de textes ou d'objets { id, versions, optional, unless }.
fn deps_fabric(source: Option<&Value>, l: &mut Vec<Dependance>) {
    match source {
        Some(Value::Array(a)) => {
            for item in a {
                match item {
                    Value::String(id) => l.push(Dependance { id: id.clone(), range: json!("*"), maven: false }),
                    Value::Object(o) => {
                        let Some(id) = o.get("id").and_then(Value::as_str) else { continue };
                        if o.get("optional").is_some_and(|v| v.as_bool() == Some(true)) || o.get("unless").is_some_and(|v| !v.is_null()) {
                            continue;
                        }
                        let versions = o.get("versions").cloned().unwrap_or(json!("*"));
                        let lisible = versions.is_string() || versions.as_array().is_some_and(|a| a.iter().all(Value::is_string));
                        l.push(Dependance { id: id.into(), range: if lisible { versions } else { Value::Null }, maven: false });
                    }
                    _ => {}
                }
            }
        }
        Some(Value::Object(o)) => l.extend(o.iter().map(|(id, plage)| Dependance { id: id.clone(), range: plage.clone(), maven: false })),
        _ => {}
    }
}

fn lire_fabric(j: &Jar, profondeur: u32) -> Option<InfoJar> {
    let d = j.json("fabric.mod.json")?;
    let id = d.get("id")?.as_str()?.to_string();
    let mut info = InfoJar { found: true, made_for: Some("fabric".into()), main_ids: vec![id.clone()], ..Default::default() };
    info.name = d.get("name").and_then(Value::as_str).map(String::from).or(Some(id));
    info.version = d.get("version").and_then(Value::as_str).map(String::from);
    info.provided.extend(d.get("provides").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from));
    deps_fabric(d.get("depends"), &mut info.depends);
    deps_fabric(d.get("breaks"), &mut info.breaks);
    let imbriques: Vec<String> =
        d.get("jars").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.get("file")?.as_str().map(String::from)).collect();
    imbriquer(j, &imbriques, &mut info, profondeur, false);
    Some(info)
}

fn lire_quilt(j: &Jar, profondeur: u32) -> Option<InfoJar> {
    let q = j.json("quilt.mod.json")?.get("quilt_loader")?.clone();
    let id = q.get("id")?.as_str()?.to_string();
    let mut info = InfoJar { found: true, made_for: Some("quilt".into()), main_ids: vec![id.clone()], ..Default::default() };
    info.name = q.pointer("/metadata/name").and_then(Value::as_str).map(String::from).or(Some(id));
    info.version = q.get("version").and_then(Value::as_str).map(String::from);
    for p in q.get("provides").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = p.as_str().or_else(|| p.get("id").and_then(Value::as_str)) {
            info.provided.push(id.into());
        }
    }
    deps_fabric(q.get("depends"), &mut info.depends);
    deps_fabric(q.get("breaks"), &mut info.breaks);
    let imbriques: Vec<String> =
        q.get("jars").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
    imbriquer(j, &imbriques, &mut info, profondeur, false);
    Some(info)
}

fn lire_toml(j: &Jar, profondeur: u32, neo_d_abord: bool) -> Option<InfoJar> {
    let noms = if neo_d_abord {
        ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]
    } else {
        ["META-INF/mods.toml", "META-INF/neoforge.mods.toml"]
    };
    let (nom, octets) = noms.iter().find_map(|n| j.lire(n).map(|o| (*n, o)))?;
    let texte = String::from_utf8_lossy(&octets);
    let mut info = InfoJar { made_for: Some(if nom.contains("neoforge") { "neoforge" } else { "forge" }.into()), ..Default::default() };
    let sections = sections_toml(&texte);
    for (n, v) in &sections {
        if n == "mods"
            && let Some(id) = v.get("modId")
        {
            info.main_ids.push(id.clone());
            info.name = info.name.take().or_else(|| v.get("displayName").cloned());
            info.version = info.version.take().or_else(|| v.get("version").cloned());
        }
    }
    if info.main_ids.is_empty() {
        return None;
    }
    info.found = true;
    for (n, v) in &sections {
        let Some(id) = v.get("modId").filter(|_| n.starts_with("dependencies")) else { continue };
        let plage = json!(v.get("versionRange").cloned().unwrap_or_else(|| "*".into()));
        let genre = v.get("type").map(|g| g.to_lowercase());
        let d = Dependance { id: id.clone(), range: plage, maven: true };
        if genre.as_deref() == Some("incompatible") {
            info.breaks.push(d);
        } else if v.get("mandatory").map(String::as_str) == Some("true") || genre.as_deref() == Some("required") {
            info.depends.push(d);
        }
    }
    // Jars imbriqués : ceux listés par META-INF/jarjar/metadata.json, plus ceux du dossier jarjar.
    let mut fichiers: Vec<String> = j
        .json("META-INF/jarjar/metadata.json")
        .and_then(|m| m.get("jars").cloned())
        .and_then(|l| l.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.get("path")?.as_str().map(String::from))
        .collect();
    for e in &j.entrees {
        let n = e.name.to_lowercase();
        if n.starts_with("meta-inf/jarjar/") && n.ends_with(".jar") && n.len() > "meta-inf/jarjar/.jar".len() && !fichiers.contains(&e.name)
        {
            fichiers.push(e.name.clone());
        }
    }
    imbriquer(j, &fichiers, &mut info, profondeur, neo_d_abord);
    Some(info)
}

/// Les mods fournis par un jar imbriqué comptent comme présents.
fn imbriquer(j: &Jar, fichiers: &[String], info: &mut InfoJar, profondeur: u32, neo_d_abord: bool) {
    if profondeur >= PROFONDEUR_MAX {
        return;
    }
    for f in fichiers {
        // Jar imbriqué illisible : ignoré.
        if let Some(o) = j.lire(f.trim_start_matches('/'))
            && let Some(sous) = lire_jar_en(&o, "any", profondeur + 1, neo_d_abord)
        {
            info.provided.extend(sous.main_ids);
            info.provided.extend(sous.provided);
        }
    }
}

fn lire_jar_en(octets: &[u8], loader: &str, profondeur: u32, neo_d_abord: bool) -> Option<InfoJar> {
    let j = Jar { octets, entrees: zip::lister_entrees(octets).ok()? };
    let ordre: [&str; 3] = match loader {
        "quilt" => ["quilt", "fabric", "toml"],
        "forge" | "neoforge" => ["toml", "fabric", "quilt"],
        _ => ["fabric", "quilt", "toml"],
    };
    let mut info = ordre
        .iter()
        .find_map(|k| match *k {
            "fabric" => lire_fabric(&j, profondeur),
            "quilt" => lire_quilt(&j, profondeur),
            _ => lire_toml(&j, profondeur, neo_d_abord),
        })
        .unwrap_or_default();
    info.optifine = profondeur == 0 && j.entrees.iter().any(|e| e.name.starts_with("net/optifine/") || e.name.starts_with("optifine/"));
    Some(info)
}

/// Lit un jar selon le loader de l'instance (ordre des formats).
pub fn lire_jar(octets: &[u8], loader: &str) -> InfoJar {
    lire_jar_en(octets, loader, 0, loader == "neoforge").unwrap_or_default()
}

/// Identifiants fournis par un jar, ceux de ses jars imbriqués compris.
pub fn identifiants(octets: &[u8], loader: &str) -> Vec<String> {
    let i = lire_jar(octets, loader);
    let mut l: Vec<String> = vec![];
    for id in i.main_ids.into_iter().chain(i.provided) {
        if !l.contains(&id) {
            l.push(id);
        }
    }
    l
}

// ---------- Analyse ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Probleme {
    pub id: String,
    /// blocking | risk
    pub severity: &'static str,
    pub title: String,
    pub text: String,
    pub action: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency: Option<Value>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub foreign: bool,
}

#[derive(Debug, Clone)]
pub struct Mod {
    pub file: String,
    pub enabled: bool,
    pub info: InfoJar,
}

fn joindre(noms: &[String]) -> String {
    let mut u: Vec<&String> = vec![];
    for n in noms {
        if !u.contains(&n) {
            u.push(n);
        }
    }
    match u.len() {
        0 => String::new(),
        1 => u[0].clone(),
        n => format!("{} et {}", u[..n - 1].iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "), u[n - 1]),
    }
}

fn libelle(m: &Mod) -> String {
    m.info.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| {
        let f = m.file.replace(DESACTIVE, "");
        f.strip_suffix(".jar").or_else(|| f.strip_suffix(".JAR")).unwrap_or(&f).to_string()
    })
}

fn probleme(id: String, grave: bool, titre: String, texte: String, action: Option<Value>) -> Probleme {
    Probleme { id, severity: if grave { "blocking" } else { "risk" }, title: titre, text: texte, action, dependency: None, foreign: false }
}

fn plage_ok(d: &Dependance, version: Option<&str>) -> Option<bool> {
    if d.maven { plage_maven(d.range.as_str(), version) } else { plage_fabric(&d.range, version) }
}

pub fn analyser(mods: &[Mod], instance: &Instance) -> Vec<Probleme> {
    let mut problemes = vec![];
    // Un jar pour un autre loader ne sera jamais chargé : il ne fournit rien et ne réclame rien.
    let acceptes = accepte(&instance.loader);
    let etranger = |m: &Mod| acceptes.is_some_and(|a| m.info.made_for.as_ref().is_some_and(|f| !a.contains(&f.as_str())));
    let utilisables: Vec<&Mod> = mods.iter().filter(|m| !etranger(m)).collect();
    let actifs: Vec<&Mod> = utilisables.iter().copied().filter(|m| m.enabled).collect();
    let ids_de = |m: &Mod| -> Vec<String> { m.info.main_ids.iter().chain(&m.info.provided).cloned().collect() };

    let mut presents: HashMap<String, Vec<&Mod>> = HashMap::new();
    let mut dormants: HashMap<String, Vec<&Mod>> = HashMap::new();
    for m in &utilisables {
        let cible = if m.enabled { &mut presents } else { &mut dormants };
        let mut ids: Vec<String> = ids_de(m);
        if m.info.optifine {
            ids.push("optifine".into());
        }
        let mut vus = HashSet::new();
        for id in ids.into_iter().filter(|i| vus.insert(i.clone())) {
            cible.entry(id).or_default().push(m);
        }
    }

    for m in mods.iter().filter(|m| m.enabled && etranger(m)) {
        let fait_pour = nom_loader(m.info.made_for.as_deref().unwrap_or(""));
        let mut p = probleme(
            format!("loader:{}", m.file),
            true,
            t("mod_check.autre_loader"),
            tv("mod_check.fait_pour_autre_loader", &[("m", &libelle(m)), ("madeFor", fait_pour), ("loader", nom_loader(&instance.loader))]),
            Some(json!({ "type": "disable", "label": t("mod_check.desactiver"), "file": m.file })),
        );
        p.foreign = true;
        problemes.push(p);
    }

    // Dépendances obligatoires (ordre d'apparition gardé, comme une Map en JavaScript).
    let mut manquantes: Vec<(String, Vec<String>, Option<&Mod>)> = vec![];
    let mut anciennes: Vec<(String, Vec<String>, &Mod)> = vec![];
    let mc = instance.version.as_str();
    for m in &actifs {
        let propres: HashSet<String> = ids_de(m).into_iter().collect();
        for d in &m.info.depends {
            if propres.contains(&d.id) {
                continue;
            }
            if d.id == "minecraft" {
                if plage_ok(d, Some(mc)) == Some(false) {
                    problemes.push(probleme(
                        format!("mc:{}", m.file),
                        true,
                        t("mod_check.version_de_minecraft"),
                        tv("mod_check.est_pas_prevu_pour_minecraft", &[("m", &libelle(m)), ("minecraft", mc)]),
                        None,
                    ));
                }
                continue;
            }
            if IGNORES.contains(&d.id.as_str()) {
                continue;
            }
            if let Some(p) = presents.get(&d.id) {
                // Seule la version du mod lui-même est connue, pas celle d'un jar imbriqué.
                let fournisseur = p.iter().find(|x| x.info.main_ids.contains(&d.id));
                if let Some(f) = fournisseur
                    && d.range != json!("*")
                    && !d.range.is_null()
                    && plage_ok(d, f.info.version.as_deref()) == Some(false)
                {
                    match anciennes.iter_mut().find(|(id, _, _)| *id == d.id) {
                        Some((_, l, _)) if !l.contains(&libelle(m)) => l.push(libelle(m)),
                        Some(_) => {}
                        None => anciennes.push((d.id.clone(), vec![libelle(m)], f)),
                    }
                }
                continue;
            }
            match manquantes.iter_mut().find(|(id, _, _)| *id == d.id) {
                Some((_, l, _)) => l.push(libelle(m)),
                None => manquantes.push((d.id.clone(), vec![libelle(m)], dormants.get(&d.id).and_then(|l| l.first().copied()))),
            }
        }
    }
    for (id, besoins, desactive) in manquantes {
        let n = besoins.len().to_string();
        match desactive {
            Some(d) => problemes.push(probleme(
                format!("dep:{id}"),
                true,
                t("mod_check.dependance_desactivee"),
                tv("mod_check.dep_disabled", &[("count", &n), ("mods", &joindre(&besoins)), ("dep", &libelle(d))]),
                Some(json!({ "type": "enable", "label": t("mod_check.activer"), "file": d.file })),
            )),
            None => {
                let mut p = probleme(
                    format!("dep:{id}"),
                    true,
                    t("mod_check.dependance_manquante"),
                    tv("mod_check.dep_missing", &[("count", &n), ("mods", &joindre(&besoins)), ("id", &id)]),
                    None,
                );
                p.dependency = Some(json!({ "id": id }));
                problemes.push(p);
            }
        }
    }
    for (id, besoins, f) in anciennes {
        let mut p = probleme(
            format!("dep-old:{id}"),
            true,
            t("mod_check.dependance_trop_ancienne"),
            tv(
                "mod_check.dep_outdated",
                &[
                    ("count", &besoins.len().to_string()),
                    ("mods", &joindre(&besoins)),
                    ("dep", &libelle(f)),
                    ("version", f.info.version.as_deref().unwrap_or("")),
                ],
            ),
            None,
        );
        p.dependency = Some(json!({ "id": id, "outdated": f.file }));
        problemes.push(p);
    }

    // Doublons : même identifiant principal dans plusieurs jars actifs ; le plus ancien peut partir.
    let mut par_id: Vec<(String, Vec<&Mod>)> = vec![];
    for m in &actifs {
        let mut vus = HashSet::new();
        for id in m.info.main_ids.iter().filter(|i| vus.insert((*i).clone())) {
            match par_id.iter_mut().find(|(i, _)| i == id) {
                Some((_, l)) => l.push(m),
                None => par_id.push((id.clone(), vec![m])),
            }
        }
    }
    let mut doublons: HashSet<String> = HashSet::new();
    for (id, groupe) in par_id.into_iter().filter(|(_, g)| g.len() > 1) {
        let mut tries = groupe.clone();
        tries.sort_by(|a, b| match (a.info.version.as_deref().and_then(parties), b.info.version.as_deref().and_then(parties)) {
            (Some(x), Some(y)) if comparer(&x, &y) != Ordering::Equal => comparer(&x, &y),
            _ => naturel(&a.file, &b.file),
        });
        let retire = tries[0];
        if !doublons.insert(retire.file.clone()) {
            continue;
        }
        let fichiers: Vec<String> = groupe.iter().map(|g| g.file.clone()).collect();
        problemes.push(probleme(
            format!("dup:{id}"),
            false,
            t("mod_check.mod_en_double"),
            tv("mod_check.contiennent_tous_le_mod_le", &[("group", &joindre(&fichiers)), ("id", &id), ("file", &retire.file)]),
            Some(json!({ "type": "disable", "label": t("mod_check.desactiver"), "file": retire.file })),
        ));
    }

    // Incompatibilités déclarées
    let mut paires: HashSet<String> = HashSet::new();
    for m in &actifs {
        for b in &m.info.breaks {
            if IGNORES.contains(&b.id.as_str()) {
                continue;
            }
            for autre in presents.get(&b.id).into_iter().flatten().filter(|x| !std::ptr::eq(**x, *m)) {
                let version = autre.info.main_ids.contains(&b.id).then(|| autre.info.version.clone()).flatten();
                let touche = if b.range == json!("*") { Some(true) } else { plage_ok(b, version.as_deref()) };
                if touche != Some(true) {
                    continue;
                }
                let mut cle = [m.file.clone(), autre.file.clone()];
                cle.sort();
                let cle = cle.join("|");
                if !paires.insert(cle.clone()) {
                    continue;
                }
                problemes.push(probleme(
                    format!("breaks:{cle}"),
                    false,
                    t("common.mods_incompatibles"),
                    tv("mod_check.se_declare_incompatible_avec", &[("m", &libelle(m)), ("value", &libelle(autre))]),
                    Some(json!({ "type": "disable", "label": t("mod_check.desactiver"), "file": autre.file, "target": libelle(autre) })),
                ));
            }
        }
    }

    // Sodium / Iris avec OptiFine
    if let Some(of) = presents.get("optifine").and_then(|l| l.first()) {
        for (id, nom) in [("sodium", "Sodium"), ("iris", "Iris")] {
            if presents.contains_key(id) {
                problemes.push(probleme(
                    format!("optifine:{id}"),
                    false,
                    t("mod_check.mods_en_double"),
                    tv("mod_check.et_optifine_font_le_meme", &[("name", nom)]),
                    Some(json!({ "type": "disable", "label": t("mod_check.desactiver"), "file": of.file, "target": "OptiFine" })),
                ));
            }
        }
    }
    problemes
}

/// Tri naturel des noms de fichiers (« mod-2 » avant « mod-10 »).
fn naturel(a: &str, b: &str) -> Ordering {
    let morceaux = |s: &str| -> Vec<(bool, String)> {
        let mut l: Vec<(bool, String)> = vec![];
        for c in s.to_lowercase().chars() {
            let chiffre = c.is_ascii_digit();
            match l.last_mut() {
                Some((d, t)) if *d == chiffre => t.push(c),
                _ => l.push((chiffre, c.to_string())),
            }
        }
        l
    };
    for (x, y) in morceaux(a).iter().zip(morceaux(b).iter()) {
        let o = if x.0 && y.0 { x.1.parse::<u128>().unwrap_or(0).cmp(&y.1.parse::<u128>().unwrap_or(0)) } else { x.1.cmp(&y.1) };
        if o != Ordering::Equal {
            return o;
        }
    }
    a.len().cmp(&b.len())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnostic {
    pub count: usize,
    pub problems: Vec<Probleme>,
}

/// Contrôle avec ses caches : jars relus seulement s'ils changent, résultat gardé tant que le dossier ne change pas.
#[derive(Default)]
pub struct Controle {
    fichiers: Mutex<HashMap<PathBuf, (Etat, String, InfoJar)>>,
    resultats: Mutex<HashMap<PathBuf, (String, Diagnostic)>>,
}

impl Controle {
    fn info(&self, base: Option<&Base>, f: &Path, etat: Etat, loader: &str) -> InfoJar {
        if let Some((e, l, i)) = self.fichiers.lock().unwrap_or_else(|e| e.into_inner()).get(f)
            && *e == etat
            && l == loader
        {
            return i.clone();
        }
        // Déjà lu lors d'une ouverture précédente du launcher, pour ce loader (launcher.db).
        let partie = format!("check:{loader}");
        let cle = f.to_string_lossy().into_owned();
        let garde = base.and_then(|b| rappeler(b, &cle, etat, &partie)).and_then(|(_, v)| serde_json::from_value::<InfoJar>(v).ok());
        let info = match garde {
            Some(i) => i,
            None => match std::fs::read(f) {
                Ok(o) => {
                    let i = lire_jar(&o, loader);
                    if let Some(b) = base {
                        retenir(b, &cle, etat, &sha1(&o), &partie, serde_json::to_value(&i).unwrap_or_default());
                    }
                    i
                }
                // Archive illisible : aucun avis.
                Err(_) => InfoJar::default(),
            },
        };
        self.fichiers.lock().unwrap_or_else(|e| e.into_inner()).insert(f.into(), (etat, loader.into(), info.clone()));
        info
    }

    /// Problèmes à régler avant de lancer. Instance vanilla : aucun contrôle.
    pub fn controler(&self, base: Option<&Base>, dossier_jeu: &Path, instance: &Instance) -> Diagnostic {
        let loader = instance.loader.as_str();
        if loader.is_empty() || loader == "vanilla" {
            return Diagnostic { count: 0, problems: vec![] };
        }
        let dossier = dossier_jeu.join("mods");
        let (Ok(it), Ok(md)) = (std::fs::read_dir(&dossier), std::fs::metadata(&dossier)) else {
            return Diagnostic { count: 0, problems: vec![] };
        };
        let mut jars: Vec<String> = it
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.replace(DESACTIVE, "").to_lowercase().ends_with(".jar"))
            .collect();
        jars.sort();
        let date = Etat::de(&md).mtime_ms;
        let cle = format!("{}|{date}|{}|{loader}|{}|{}", langue(), jars.len(), instance.version, jars.join("/"));
        if let Some((k, d)) = self.resultats.lock().unwrap_or_else(|e| e.into_inner()).get(&dossier)
            && *k == cle
        {
            return d.clone();
        }
        let mut mods = vec![];
        for f in &jars {
            let chemin = dossier.join(f);
            // Fichier déplacé pendant la lecture : ignoré.
            let Ok(m) = std::fs::metadata(&chemin) else { continue };
            if !m.is_file() {
                continue;
            }
            mods.push(Mod { file: f.clone(), enabled: !f.ends_with(DESACTIVE), info: self.info(base, &chemin, Etat::de(&m), loader) });
        }
        let d = Diagnostic { count: mods.iter().filter(|m| m.enabled).count(), problems: analyser(&mods, instance) };
        self.resultats.lock().unwrap_or_else(|e| e.into_inner()).insert(dossier, (cle, d.clone()));
        d
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;

    fn f(plage: Value, v: &str) -> Option<bool> {
        plage_fabric(&plage, Some(v))
    }

    #[test]
    fn plages_fabric() {
        let s = |p: &str| json!(p);
        assert_eq!(f(s(">=1.20"), "1.20.1"), Some(true));
        assert_eq!(f(s(">=1.20.2"), "1.20.1"), Some(false));
        assert_eq!(f(s("<1.21"), "1.20.6"), Some(true));
        assert_eq!(f(s("1.21.1"), "1.21.1"), Some(true));
        assert_eq!(f(s("=1.21.1"), "1.21"), Some(false));
        assert_eq!(f(s("*"), "1.8.9"), Some(true));
        assert_eq!(f(s(""), "1.8.9"), Some(true));
        assert_eq!(f(s(">=1.20 <1.21"), "1.20.4"), Some(true));
        assert_eq!(f(s(">=1.20 <1.21"), "1.21"), Some(false));
        assert_eq!(f(s(">= 1.20"), "1.20.1"), Some(true));
        assert_eq!(f(s("1.20.1 || 1.20.4"), "1.20.4"), Some(true));
        assert_eq!(f(json!(["1.20.1", "1.20.2"]), "1.20.2"), Some(true));
        assert_eq!(f(json!(["1.20.1", "1.20.2"]), "1.20.3"), Some(false));
        assert_eq!(f(s("1.20.x"), "1.20.4"), Some(true));
        assert_eq!(f(s("1.20.x"), "1.21"), Some(false));
        assert_eq!(f(s("1.21.*"), "1.21.1"), Some(true));
        assert_eq!(f(s("~1.20"), "1.20.6"), Some(true));
        assert_eq!(f(s("~1.20"), "1.21"), Some(false));
        assert_eq!(f(s("^1.2"), "1.9"), Some(true));
        assert_eq!(f(s("^1.2"), "2.0"), Some(false));
        assert_eq!(f(s(">=0.15.0"), "0.17.2+build.1"), Some(true));
        assert_eq!(f(s(">=1.21-beta.1"), "1.21.1"), Some(true));
        assert_eq!(f(s("^0.5"), "0.5.3"), None);
        assert_eq!(f(s("banane"), "1.20.1"), None);
        assert_eq!(plage_fabric(&s(">=1.20"), None), None);
        assert_eq!(f(json!([42]), "1.20.1"), None);
        assert_eq!(f(s("banane || 1.20.1"), "1.20.1"), Some(true));
    }

    #[test]
    fn plages_maven() {
        let m = |p: &str, v: &str| plage_maven(Some(p), Some(v));
        assert_eq!(m("[1.20,1.21)", "1.20.1"), Some(true));
        assert_eq!(m("[1.20,1.21)", "1.21"), Some(false));
        assert_eq!(m("[1.20,1.21]", "1.21"), Some(true));
        assert_eq!(m("(1.20,1.21)", "1.20"), Some(false));
        assert_eq!(m("[1.20.1,)", "1.21.4"), Some(true));
        assert_eq!(m("(,1.20]", "1.19.2"), Some(true));
        assert_eq!(m("(,1.20]", "1.20.1"), Some(false));
        assert_eq!(m("[1.21.1]", "1.21.1"), Some(true));
        assert_eq!(m("[1.21.1]", "1.21"), Some(false));
        assert_eq!(m("[1.18,1.19),[1.20,1.21)", "1.20.4"), Some(true));
        assert_eq!(m("[1.18,1.19),[1.20,1.21)", "1.19.2"), Some(false));
        assert_eq!(m("[47,)", "47.4.0"), Some(true));
        assert_eq!(m("1.20.1", "1.20.1"), None);
        assert_eq!(m("[1.20,1.21) et plus", "1.20.1"), None);
        assert_eq!(m("[banane]", "1.20.1"), None);
        assert_eq!(m("[1.20,1.21)", "snapshot"), None);
        assert_eq!(plage_maven(None, Some("1.20.1")), None);
    }

    fn jar_fabric(id: &str, version: &str, depends: Value, breaks: Value) -> Vec<u8> {
        let j = json!({ "id": id, "name": id.to_uppercase(), "version": version, "depends": depends, "breaks": breaks });
        zip::creer_zip(&[("fabric.mod.json", j.to_string().as_bytes())])
    }

    #[test]
    fn diagnostic_complet() {
        let d = Dossier::nouveau("controle-mods");
        let mods = d.0.join("mods");
        std::fs::create_dir_all(&mods).unwrap();
        let ecrire = |n: &str, o: Vec<u8>| std::fs::write(mods.join(n), o).unwrap();
        ecrire(
            "a.jar",
            jar_fabric("a", "1.0", json!({ "b": "*", "c": ">=2.0", "minecraft": "1.20.x", "fabricloader": "*" }), json!({ "e": "*" })),
        );
        ecrire("c.jar", jar_fabric("c", "1.5", json!({}), json!({})));
        ecrire("d.jar.disabled", jar_fabric("d", "1.0", json!({}), json!({})));
        ecrire("f.jar", jar_fabric("f", "1.0", json!({ "d": "*" }), json!({})));
        ecrire("e-1.jar", jar_fabric("e", "1.0", json!({}), json!({})));
        ecrire("e-2.jar", jar_fabric("e", "2.0", json!({}), json!({})));
        let neo = b"[[mods]]\nmodId=\"neo\"\nversion=\"1\"\n".as_slice();
        ecrire("neo.jar", zip::creer_zip(&[("META-INF/neoforge.mods.toml", neo)]));
        let instance = Instance { loader: "fabric".into(), version: "1.21.11".into(), ..Default::default() };
        let c = Controle::default();
        let diag = c.controler(None, &d.0, &instance);
        let ids: Vec<&str> = diag.problems.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(diag.count, 6);
        assert!(ids.contains(&"loader:neo.jar"), "{ids:?}");
        assert!(ids.contains(&"mc:a.jar"));
        assert!(ids.contains(&"dep:b") && ids.contains(&"dep-old:c") && ids.contains(&"dep:d"));
        assert!(ids.contains(&"dup:e") && ids.iter().any(|i| i.starts_with("breaks:")));
        let d_desactive = diag.problems.iter().find(|p| p.id == "dep:d").unwrap();
        assert_eq!(d_desactive.action.as_ref().unwrap()["type"], "enable");
        let manque = diag.problems.iter().find(|p| p.id == "dep:b").unwrap();
        assert_eq!(manque.dependency, Some(json!({ "id": "b" })));
        let double = diag.problems.iter().find(|p| p.id == "dup:e").unwrap();
        assert_eq!(double.action.as_ref().unwrap()["file"], "e-1.jar");
        assert_eq!(c.controler(None, &d.0, &Instance { loader: "vanilla".into(), ..instance.clone() }).problems.len(), 0);
        assert_eq!(joindre(&["a".into(), "b".into(), "a".into(), "c".into()]), "a, b et c");
        assert_eq!(identifiants(&jar_fabric("x", "1", json!({}), json!({})), "fabric"), ["x"]);
    }
}
