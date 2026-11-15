//! Skins et capes, comme core/skins.js : profils publics de Mojang, textures en cache, « Mes skins » sur le disque et
//! envoi au compte Microsoft. Référence : https://minecraft.wiki/w/Mojang_API

use crate::comptes::Comptes;
use crate::erreur::{Erreur, Resultat};
use crate::fichiers::{ecrire_json, lire_json};
use crate::i18n::{langue, t, tv};
use crate::microsoft::{self, Points};
use crate::net::{Options, Reseau};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Garde-fou local : Mojang ne publie pas de limite.
const PNG_MAX: usize = 2 * 1024 * 1024;
const SIGNATURE_PNG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const APPARENCE_VALIDE_MS: i64 = 30 * 60 * 1000;
const NOUVEL_ESSAI_MS: i64 = 5 * 60 * 1000;
/// Après un refus de Mojang (429) : des refus répétés peuvent suspendre le compte.
const PAUSE_MS: i64 = 60 * 1000;

/// Adresses publiques de Mojang, remplaçables pour les tests.
#[derive(Debug, Clone)]
pub struct Mojang {
    pub lookup: String,
    pub session: String,
    pub textures: String,
}

impl Default for Mojang {
    fn default() -> Self {
        Self {
            lookup: "https://api.minecraftservices.com/minecraft/profile/lookup/name".into(),
            session: "https://sessionserver.mojang.com/session/minecraft/profile".into(),
            textures: "https://textures.minecraft.net/texture".into(),
        }
    }
}

fn hash_valide(h: &str) -> bool {
    (32..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Empreinte d'une texture de Mojang ; None pour toute autre adresse.
pub fn empreinte_texture(url: &str) -> Option<String> {
    let reste = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let h = reste.strip_prefix("textures.minecraft.net/texture/")?.to_lowercase();
    hash_valide(&h).then_some(h)
}

pub fn taille_png(o: &[u8]) -> Option<(u32, u32)> {
    if o.len() < 24 || o[..8] != SIGNATURE_PNG {
        return None;
    }
    let lire = |i: usize| u32::from_be_bytes([o[i], o[i + 1], o[i + 2], o[i + 3]]);
    Some((lire(16), lire(20)))
}

/// Vérifie qu'un fichier est un skin que le jeu accepte ; renvoie sa hauteur.
pub fn verifier_skin(o: &[u8]) -> Resultat<u32> {
    if o.len() > PNG_MAX {
        return Err(Erreur::new(t("common.ce_fichier_est_trop_lourd")));
    }
    let (l, h) = taille_png(o).ok_or_else(|| Erreur::new(t("skins.ce_fichier_est_pas_une")))?;
    if l != 64 || (h != 64 && h != 32) {
        return Err(Erreur::new(tv("skins.un_skin_fait_64_64", &[("width", &l.to_string()), ("height", &h.to_string())])));
    }
    Ok(h)
}

pub fn variante(v: &str) -> &'static str {
    if v.eq_ignore_ascii_case("slim") { "slim" } else { "classic" }
}

fn nom_propre(brut: &str) -> String {
    let sans = brut.strip_suffix(".png").or_else(|| brut.strip_suffix(".PNG")).unwrap_or(brut);
    let propre: String = sans.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let court: String = propre.chars().take(24).collect();
    if court.is_empty() { "Skin".into() } else { court }
}

/// Appel public à Mojang : None pour 404 et 204.
async fn public(reseau: &Reseau, url: &str) -> Resultat<Option<Value>> {
    let o = Options {
        inactivite: Duration::from_secs(15),
        essais: 1,
        entetes: vec![("Accept".into(), "application/json".into())],
        ..Options::default()
    };
    let r = reseau.envoyer(url, &o).await.map_err(|e| Erreur::new(tv("skins.mojang_ne_repond_pas", &[("code", &e.message)])))?;
    match r.statut {
        404 | 204 => Ok(None),
        429 => Err(Erreur::new(t("skins.trop_de_requetes_vers_mojang"))),
        s if !(200..300).contains(&s) => Err(Erreur::new(tv("skins.mojang_repondu", &[("status", &s.to_string())]))),
        _ => {
            let o = r.tout().await.map_err(|e| Erreur::new(tv("skins.mojang_ne_repond_pas", &[("code", &e.message)])))?;
            Ok(serde_json::from_slice(&o).ok())
        }
    }
}

fn encoder(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// (uuid, nom) du joueur qui possède ce pseudo.
pub async fn chercher_joueur(reseau: &Reseau, m: &Mojang, nom: &str) -> Resultat<Option<(String, String)>> {
    let v = public(reseau, &format!("{}/{}", m.lookup, encoder(nom))).await?;
    Ok(v.and_then(|v| Some((v.get("id")?.as_str()?.to_string(), v.get("name").and_then(Value::as_str).unwrap_or(nom).to_string()))))
}

/// Skin et cape publics d'un joueur, d'après le serveur de sessions : ({hash, variant}, {hash}).
pub async fn apparence_publique(reseau: &Reseau, m: &Mojang, uuid: &str) -> Resultat<(Option<Value>, Option<Value>)> {
    let corps = public(reseau, &format!("{}/{}", m.session, encoder(uuid))).await?;
    let code = corps.as_ref().and_then(|c| {
        c.get("properties")?
            .as_array()?
            .iter()
            .find(|p| p.get("name") == Some(&json!("textures")))?
            .get("value")?
            .as_str()
            .map(String::from)
    });
    let Some(textures) = code.and_then(|c| B64.decode(c).ok()).and_then(|o| serde_json::from_slice::<Value>(&o).ok()) else {
        return Ok((None, None));
    };
    let skin = textures.pointer("/textures/SKIN/url").and_then(Value::as_str).and_then(empreinte_texture).map(|h| {
        json!({ "hash": h, "variant": variante(textures.pointer("/textures/SKIN/metadata/model").and_then(Value::as_str).unwrap_or("")) })
    });
    let cape = textures.pointer("/textures/CAPE/url").and_then(Value::as_str).and_then(empreinte_texture).map(|h| json!({ "hash": h }));
    Ok((skin, cape))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinRange {
    pub id: String,
    pub name: String,
    pub variant: String,
    #[serde(default)]
    pub legacy: bool,
    #[serde(default)]
    pub added_at: i64,
}

/// Cache des textures de Mojang et bibliothèque « Mes skins » (un PNG par skin et library.json).
pub struct Bibliotheque {
    cache: PathBuf,
    dossier: PathBuf,
    fichier: PathBuf,
    items: Mutex<Vec<SkinRange>>,
    reseau: Arc<Reseau>,
    mojang: Mojang,
}

impl Bibliotheque {
    pub fn new(dossier_skins: &Path, cache: &Path, reseau: Arc<Reseau>, mojang: Mojang) -> Self {
        let fichier = dossier_skins.join("library.json");
        let items = lire_json(&fichier).unwrap_or_default();
        Self { cache: cache.join("skins"), dossier: dossier_skins.into(), fichier, items: Mutex::new(items), reseau, mojang }
    }

    fn items(&self) -> std::sync::MutexGuard<'_, Vec<SkinRange>> {
        self.items.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn liste(&self) -> Vec<Value> {
        let mut l = self.items().clone();
        l.sort_by_key(|i| std::cmp::Reverse(i.added_at));
        l.into_iter().map(|i| json!({ "id": i.id, "name": i.name, "variant": i.variant, "legacy": i.legacy })).collect()
    }

    pub fn contient(&self, id: &str) -> bool {
        self.items().iter().any(|i| i.id == id)
    }

    pub fn fichier_skin(&self, id: &str) -> Resultat<PathBuf> {
        if !self.contient(id) {
            return Err(Erreur::new(t("skins.ce_skin_est_plus_dans")));
        }
        Ok(self.dossier.join(format!("{id}.png")))
    }

    /// Ajoute un PNG ; le même fichier n'est gardé qu'une fois. Renvoie (skin, ajouté).
    pub fn ajouter(&self, png: &[u8], nom: &str, var: &str) -> Resultat<(SkinRange, bool)> {
        let hauteur = verifier_skin(png)?;
        let id: String = sha2::Sha256::digest(png).iter().take(16).map(|b| format!("{b:02x}")).collect();
        let mut items = self.items();
        if let Some(connu) = items.iter().find(|i| i.id == id) {
            return Ok((connu.clone(), false));
        }
        std::fs::create_dir_all(&self.dossier)?;
        std::fs::write(self.dossier.join(format!("{id}.png")), png)?;
        let item = SkinRange {
            id,
            name: nom_propre(nom),
            variant: variante(var).into(),
            legacy: hauteur == 32,
            added_at: crate::base::maintenant(),
        };
        items.push(item.clone());
        ecrire_json(&self.fichier, &*items)?;
        Ok((item, true))
    }

    pub fn changer_variante(&self, id: &str, var: &str) -> Resultat<()> {
        let mut items = self.items();
        let item = items.iter_mut().find(|i| i.id == id).ok_or_else(|| Erreur::new(t("skins.ce_skin_est_plus_dans")))?;
        item.variant = variante(var).into();
        Ok(ecrire_json(&self.fichier, &*items)?)
    }

    pub fn retirer(&self, id: &str) -> Resultat<()> {
        let mut items = self.items();
        if !items.iter().any(|i| i.id == id) {
            return Ok(());
        }
        let _ = std::fs::remove_file(self.dossier.join(format!("{id}.png")));
        items.retain(|i| i.id != id);
        Ok(ecrire_json(&self.fichier, &*items)?)
    }

    /// Chemin local d'une texture de Mojang, téléchargée à la première demande.
    pub async fn texture(&self, brut: &str) -> Resultat<PathBuf> {
        let h = brut.to_lowercase();
        if !hash_valide(&h) {
            return Err(Erreur::new(t("skins.texture_inconnue")));
        }
        let f = self.cache.join(format!("{h}.png"));
        if f.is_file() {
            return Ok(f);
        }
        let o = Options { inactivite: Duration::from_secs(15), essais: 1, ..Options::default() };
        let r = self.reseau.envoyer(&format!("{}/{h}", self.mojang.textures), &o).await;
        let r = r.map_err(|e| Erreur::new(tv("skins.texture_indisponible", &[("code", &e.message)])))?;
        if !(200..300).contains(&r.statut) {
            return Err(Erreur::new(tv("skins.texture_indisponible_2", &[("status", &r.statut.to_string())])));
        }
        let png = r.tout().await.map_err(|e| Erreur::new(tv("skins.texture_indisponible", &[("code", &e.message)])))?;
        if png.len() > PNG_MAX || taille_png(&png).is_none() {
            return Err(Erreur::new(t("skins.texture_illisible")));
        }
        self.garder_texture(&h, &png)?;
        Ok(f)
    }

    pub fn garder_texture(&self, h: &str, png: &[u8]) -> Resultat<()> {
        std::fs::create_dir_all(&self.cache)?;
        let f = self.cache.join(format!("{h}.png"));
        let tmp = f.with_extension(format!("png.{}.tmp", std::process::id()));
        std::fs::write(&tmp, png)?;
        Ok(std::fs::rename(tmp, f)?)
    }
}

/// « 14/11 » (« 11/14 » en anglais), pour nommer l'ancien skin.
fn date_courte() -> String {
    let d = chrono::Local::now();
    if langue() == "en" { d.format("%m/%d").to_string() } else { d.format("%d/%m").to_string() }
}

/// Lie les comptes aux skins : apparence publique, profil Minecraft, envoi vers Mojang.
pub struct GardeRobe {
    pub comptes: Arc<Comptes>,
    pub biblio: Arc<Bibliotheque>,
    reseau: Arc<Reseau>,
    points: Points,
    essais: Mutex<HashMap<String, i64>>,
    pauses: Mutex<HashMap<String, i64>>,
    rafraichir: tokio::sync::Mutex<()>,
}

fn texte(v: &Value, c: &str) -> String {
    v.get(c).and_then(Value::as_str).unwrap_or("").to_string()
}

impl GardeRobe {
    pub fn new(comptes: Arc<Comptes>, biblio: Arc<Bibliotheque>, reseau: Arc<Reseau>, points: Points) -> Self {
        Self {
            comptes,
            biblio,
            reseau,
            points,
            essais: Mutex::default(),
            pauses: Mutex::default(),
            rafraichir: tokio::sync::Mutex::new(()),
        }
    }

    /// Une texture de 64×32 est un ancien format : le jeu copie alors le bras et la jambe droits à gauche.
    async fn avec_format(&self, skin: Option<Value>) -> Option<Value> {
        let mut s = skin?;
        let hauteur = match self.biblio.texture(&texte(&s, "hash")).await {
            Ok(f) => std::fs::read(f).ok().and_then(|o| taille_png(&o)).map(|(_, h)| h),
            Err(_) => None,
        };
        s["legacy"] = (hauteur == Some(32)).into();
        Some(s)
    }

    /// Têtes des comptes, depuis l'API publique. Hors connexion, la dernière apparence connue reste.
    pub async fn rafraichir(&self) -> crate::comptes::Liste {
        let _un_seul = self.rafraichir.lock().await;
        let mojang = self.biblio.mojang.clone();
        for compte in self.comptes.tous() {
            let id = texte(&compte, "id");
            let maintenant = crate::base::maintenant();
            let verifie = compte.pointer("/look/checkedAt").and_then(Value::as_i64).unwrap_or(0);
            let essaye = self.essais.lock().unwrap_or_else(|e| e.into_inner()).get(&id).copied().unwrap_or(0);
            if maintenant - verifie < APPARENCE_VALIDE_MS || maintenant - essaye < NOUVEL_ESSAI_MS {
                continue;
            }
            self.essais.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), maintenant);
            let travail = async {
                let uuid = if texte(&compte, "type") == "microsoft" {
                    Some(texte(&compte, "uuid"))
                } else {
                    chercher_joueur(&self.reseau, &mojang, &texte(&compte, "name")).await?.map(|(u, _)| u)
                };
                let (skin, cape) = match uuid {
                    Some(u) => apparence_publique(&self.reseau, &mojang, &u).await?,
                    None => (None, None),
                };
                let mut skin = self.avec_format(skin).await;
                let avant = compte.pointer("/look/skin");
                if let (Some(s), Some(a)) = (skin.as_mut(), avant)
                    && a.get("hash") == s.get("hash")
                    && let Some(lib) = a.get("libraryId").filter(|l| !l.is_null())
                {
                    s["libraryId"] = lib.clone();
                }
                let mut look = compte.get("look").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
                look["skin"] = skin.unwrap_or(Value::Null);
                look["cape"] = cape.unwrap_or(Value::Null);
                look["checkedAt"] = crate::base::maintenant().into();
                self.comptes.changer_apparence(&id, look)
            };
            // Hors connexion ou Mojang indisponible : on réessaiera plus tard.
            let _ = travail.await;
        }
        self.comptes.liste()
    }

    /// Enregistre le profil renvoyé par l'API Minecraft (skin actif et capes du compte).
    async fn garder_profil(&self, id: &str, profil: &Value, bibliotheque: Option<String>) -> Resultat<()> {
        let avant = self.comptes.compte(id)?.pointer("/look/skin").cloned();
        let actif = profil
            .get("skins")
            .and_then(Value::as_array)
            .and_then(|l| l.iter().find(|s| s.get("state") == Some(&json!("ACTIVE"))).cloned());
        let hash = actif.as_ref().and_then(|a| empreinte_texture(&texte(a, "url")));
        let skin =
            hash.clone().map(|h| json!({ "hash": h, "variant": variante(&texte(actif.as_ref().unwrap_or(&Value::Null), "variant")) }));
        let mut skin = self.avec_format(skin).await;
        let garde = bibliotheque.or_else(|| {
            avant
                .as_ref()
                .filter(|a| a.get("hash").and_then(Value::as_str) == hash.as_deref())
                .and_then(|a| a.get("libraryId")?.as_str().map(String::from))
        });
        if let (Some(s), Some(g)) = (skin.as_mut(), garde) {
            s["libraryId"] = g.into();
        }
        let capes: Vec<Value> = profil
            .get("capes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| {
                let id = c.get("id")?.as_str()?;
                let hash = empreinte_texture(&texte(c, "url"))?;
                let alias: String =
                    c.get("alias").and_then(Value::as_str).map(String::from).unwrap_or_else(|| t("skins.cape")).chars().take(30).collect();
                Some(json!({ "id": id, "alias": alias, "hash": hash, "active": texte(c, "state") == "ACTIVE" }))
            })
            .collect();
        let cape = capes.iter().find(|c| c["active"] == true).map(|c| json!({ "hash": c["hash"] }));
        let look = json!({ "skin": skin, "cape": cape, "capes": capes, "checkedAt": crate::base::maintenant() });
        self.comptes.changer_apparence(id, look)
    }

    /// État de la fenêtre « Skin et cape » ; un refus de Mojang revient dedans avec son code.
    pub fn instantane(&self, id: &str, probleme: Option<&Erreur>) -> Value {
        let mut compte =
            self.comptes.liste().accounts.into_iter().find(|a| a.id == id).map(|a| serde_json::to_value(a).unwrap_or_default());
        // L'empreinte de Mojang est celle du fichier : un skin copié depuis Mojang est reconnu dans « Mes skins ».
        if let Some(c) = compte.as_mut()
            && let Some(skin) = c.pointer_mut("/look/skin").filter(|s| s.is_object())
            && skin.get("libraryId").is_none_or(Value::is_null)
            && let Some(court) = skin.get("hash").and_then(Value::as_str).and_then(|h| h.get(..32)).map(String::from)
            && self.biblio.contient(&court)
        {
            skin["libraryId"] = court.into();
        }
        let pause = self.pauses.lock().unwrap_or_else(|e| e.into_inner()).get(id).copied().unwrap_or(0);
        json!({
            "account": compte,
            "library": self.biblio.liste(),
            "cooldownUntil": pause.max(0),
            "error": probleme.map(|e| e.message.clone()),
            "errorCode": probleme.and_then(|e| e.code),
        })
    }

    /// Pour Microsoft, le profil à jour est relu chez Mojang.
    pub async fn etat(&self, id: &str) -> Resultat<Value> {
        let c = self.comptes.compte(id)?;
        if texte(&c, "type") != "microsoft" || c.get("needsLogin") == Some(&json!(true)) {
            return Ok(self.instantane(id, None));
        }
        let (r, p) = (self.reseau.clone(), self.points.clone());
        let resultat = async {
            let profil = self
                .comptes
                .avec_jeton(id, |j| {
                    let (r, p) = (r.clone(), p.clone());
                    async move { microsoft::profil_complet(&r, &p, &j).await }
                })
                .await?;
            self.garder_profil(id, &profil, None).await
        };
        Ok(match resultat.await {
            Ok(()) => self.instantane(id, None),
            Err(e) => self.instantane(id, Some(&e)),
        })
    }

    /// Appel à Mojang qui demande un jeton. Jamais de nouvel essai après un 429.
    async fn protege<F, Fut>(&self, id: &str, action: F) -> Resultat<Value>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Resultat<Value>>,
    {
        let fin = self.pauses.lock().unwrap_or_else(|e| e.into_inner()).get(id).copied().unwrap_or(0);
        if crate::base::maintenant() < fin {
            return Err(Erreur::code(t("skins.mojang_limite_les_changements_de"), "RATE_LIMIT"));
        }
        let r = self.comptes.avec_jeton(id, action).await;
        if let Err(e) = &r
            && e.a_le_code("RATE_LIMIT")
        {
            let attente = PAUSE_MS.max(e.attendre_ms.unwrap_or(0) as i64);
            self.pauses.lock().unwrap_or_else(|e| e.into_inner()).insert(id.into(), crate::base::maintenant() + attente);
        }
        r
    }

    /// Mojang ne donne pas d'historique : le skin remplacé reste dans « Mes skins ».
    async fn garder_l_actuel(&self, id: &str) {
        let Ok(c) = self.comptes.compte(id) else { return };
        let Some(actuel) = c.pointer("/look/skin").filter(|s| s.is_object()) else { return };
        if actuel.get("libraryId").is_some_and(|l| !l.is_null()) {
            return;
        }
        // Sans la texture, le changement reste possible.
        if let Ok(f) = self.biblio.texture(&texte(actuel, "hash")).await
            && let Ok(png) = std::fs::read(f)
        {
            let _ = self.biblio.ajouter(&png, &tv("skins.ancien_skin", &[("date", &date_courte())]), &texte(actuel, "variant"));
        }
    }

    fn exiger_microsoft(&self, id: &str) -> Resultat<()> {
        if texte(&self.comptes.compte(id)?, "type") != "microsoft" {
            return Err(Erreur::new(t("skins.il_faut_un_compte_microsoft")));
        }
        Ok(())
    }

    async fn png_source(&self, source: &Value) -> Resultat<Vec<u8>> {
        if let Some(l) = source.get("library").and_then(Value::as_str) {
            return Ok(std::fs::read(self.biblio.fichier_skin(l)?)?);
        }
        if let Some(h) = source.get("texture").and_then(Value::as_str) {
            return Ok(std::fs::read(self.biblio.texture(h).await?)?);
        }
        Err(Erreur::new(t("skins.choisis_un_skin")))
    }

    /// Applique un changement : `skin` ({ library } ou { texture }) et `variant` ; `cape` : identifiant, null pour la
    /// masquer, absente pour ne pas y toucher. Si la cape échoue, le skin reste appliqué.
    pub async fn appliquer(&self, id: &str, changement: &Value) -> Resultat<Value> {
        self.exiger_microsoft(id)?;
        if let Some(source) = changement.get("skin").filter(|s| s.is_object()) {
            let png = self.png_source(source).await?;
            verifier_skin(&png)?;
            self.garder_l_actuel(id).await;
            let var = variante(&texte(changement, "variant"));
            let (r, p) = (self.reseau.clone(), self.points.clone());
            let png2 = png.clone();
            let profil = self
                .protege(id, |j| {
                    let (r, p, png) = (r.clone(), p.clone(), png2.clone());
                    async move { microsoft::envoyer_skin(&r, &p, &j, &png, var).await }
                })
                .await?;
            let actif =
                profil.get("skins").and_then(Value::as_array).and_then(|l| l.iter().find(|s| s.get("state") == Some(&json!("ACTIVE"))));
            if let Some(h) = actif.and_then(|a| empreinte_texture(&texte(a, "url"))) {
                self.biblio.garder_texture(&h, &png)?;
            }
            let lib = source.get("library").and_then(Value::as_str).map(String::from);
            self.garder_profil(id, &profil, lib).await?;
        }
        if let Some(cape) = changement.get("cape") {
            let connues = self.comptes.compte(id)?.pointer("/look/capes").and_then(Value::as_array).cloned().unwrap_or_default();
            let cape = cape.as_str().map(String::from);
            if let Some(c) = &cape
                && !connues.iter().any(|k| k.get("id").and_then(Value::as_str) == Some(c))
            {
                return Err(Erreur::new(t("skins.cette_cape_appartient_pas_ce")));
            }
            let (r, p) = (self.reseau.clone(), self.points.clone());
            let profil = self
                .protege(id, |j| {
                    let (r, p, cape) = (r.clone(), p.clone(), cape.clone());
                    async move {
                        match cape {
                            Some(c) => microsoft::montrer_cape(&r, &p, &j, &c).await,
                            None => microsoft::masquer_cape(&r, &p, &j).await,
                        }
                    }
                })
                .await?;
            self.garder_profil(id, &profil, None).await?;
        }
        Ok(self.instantane(id, None))
    }

    /// Remet le skin par défaut de Minecraft ; l'ancien reste dans « Mes skins ».
    pub async fn par_defaut(&self, id: &str) -> Resultat<Value> {
        self.exiger_microsoft(id)?;
        self.garder_l_actuel(id).await;
        let (r, p) = (self.reseau.clone(), self.points.clone());
        let profil = self
            .protege(id, |j| {
                let (r, p) = (r.clone(), p.clone());
                async move { microsoft::skin_par_defaut(&r, &p, &j).await }
            })
            .await?;
        self.garder_profil(id, &profil, None).await?;
        Ok(self.instantane(id, None))
    }

    /// Copie le skin public d'un joueur dans « Mes skins ». Rien n'est envoyé.
    pub async fn copier_joueur(&self, brut: &str) -> Resultat<(SkinRange, bool)> {
        let nom = brut.trim();
        if nom.is_empty() || nom.len() > 16 || !nom.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err(Erreur::new(t("skins.ce_pseudo_est_pas_valide")));
        }
        let mojang = self.biblio.mojang.clone();
        let (uuid, vrai_nom) = chercher_joueur(&self.reseau, &mojang, nom)
            .await?
            .ok_or_else(|| Erreur::new(tv("skins.aucun_joueur_ne_appelle", &[("name", nom)])))?;
        let (skin, _) = apparence_publique(&self.reseau, &mojang, &uuid).await?;
        let skin = skin.ok_or_else(|| Erreur::new(tv("skins.pas_de_skin_personnalise", &[("name", &vrai_nom)])))?;
        let png = std::fs::read(self.biblio.texture(&texte(&skin, "hash")).await?)?;
        self.biblio.ajouter(&png, &vrai_nom, &texte(&skin, "variant"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coffre::CoffreClair;
    use crate::comptes::SessionMs;
    use crate::essai::Dossier;
    use crate::essai_http::{Corps, Reponse, servir};

    /// PNG minimal de la taille voulue (l'en-tête suffit aux contrôles).
    fn png(l: u32, h: u32, graine: u8) -> Vec<u8> {
        let mut o = SIGNATURE_PNG.to_vec();
        o.extend([0, 0, 0, 13]);
        o.extend(b"IHDR");
        o.extend(l.to_be_bytes());
        o.extend(h.to_be_bytes());
        o.extend([8, 6, 0, 0, 0, graine]);
        o
    }

    #[test]
    fn controles_des_fichiers() {
        assert_eq!(taille_png(&png(64, 32, 0)), Some((64, 32)));
        assert_eq!(taille_png(b"pas un png du tout, non"), None);
        assert_eq!(verifier_skin(&png(64, 64, 0)).unwrap(), 64);
        assert!(verifier_skin(&png(128, 128, 0)).unwrap_err().message.contains("128"));
        assert!(verifier_skin(&vec![0u8; PNG_MAX + 1]).is_err());
        let h = "a".repeat(64);
        assert_eq!(empreinte_texture(&format!("http://textures.minecraft.net/texture/{h}")), Some(h.clone()));
        assert_eq!(empreinte_texture(&format!("https://exemple.org/texture/{h}")), None);
        assert_eq!(empreinte_texture("https://textures.minecraft.net/texture/xyz"), None);
        assert_eq!((variante("SLIM"), variante("autre")), ("slim", "classic"));
        assert_eq!(nom_propre("  Mon   skin.png"), "Mon skin");
        assert_eq!(nom_propre(".png"), "Skin");
    }

    #[test]
    fn mes_skins() {
        let d = Dossier::nouveau("skins-biblio");
        let b = Bibliotheque::new(&d.0.join("skins"), &d.0.join("cache"), Arc::new(Reseau::new()), Mojang::default());
        let (a, ajoute) = b.ajouter(&png(64, 32, 1), "Ancien.png", "classic").unwrap();
        assert!(ajoute && a.legacy && a.name == "Ancien");
        assert!(!b.ajouter(&png(64, 32, 1), "Copie", "slim").unwrap().1, "même fichier gardé une fois");
        b.ajouter(&png(64, 64, 2), "Neuf", "slim").unwrap();
        b.changer_variante(&a.id, "slim").unwrap();
        let relue = Bibliotheque::new(&d.0.join("skins"), &d.0.join("cache"), Arc::new(Reseau::new()), Mojang::default());
        assert_eq!(relue.liste().len(), 2);
        assert_eq!(relue.liste().iter().find(|s| s["id"] == a.id.as_str()).unwrap()["variant"], "slim");
        relue.retirer(&a.id).unwrap();
        assert!(relue.fichier_skin(&a.id).is_err());
        assert!(!d.0.join(format!("skins/{}.png", a.id)).exists());
    }

    #[tokio::test]
    async fn envoi_cape_et_refus_de_mojang() {
        let d = Dossier::nouveau("skins-garde-robe");
        let h1 = "1".repeat(64);
        let (h1b, serveur_png) = (h1.clone(), png(64, 64, 9));
        let compteur = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = compteur.clone();
        let serveur = servir(move |_, r| {
            let profil = |cape: &str| {
                json!({ "id": "u", "skins": [{ "state": "ACTIVE", "url": format!("http://textures.minecraft.net/texture/{h1b}"), "variant": "SLIM" }],
                        "capes": [{ "id": "c1", "alias": "Migrator", "state": cape, "url": format!("http://textures.minecraft.net/texture/{}", "2".repeat(64)) }] })
                .to_string()
            };
            match (r.methode.as_str(), r.chemin.as_str()) {
                ("POST", "/minecraft/profile/skins") => {
                    assert!(String::from_utf8_lossy(&r.corps).contains("name=\"variant\"\r\n\r\nslim"));
                    Reponse::simple(200, &profil("INACTIVE"))
                }
                ("PUT", "/minecraft/profile/capes/active") => {
                    if c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        Reponse::simple(200, &profil("ACTIVE"))
                    } else {
                        Reponse::simple(429, "").avec("Retry-After", "120")
                    }
                }
                (_, t) if t.starts_with("/texture/") => Reponse { corps: Corps::Entier(serveur_png.clone()), ..Reponse::simple(200, "") },
                _ => Reponse::simple(404, ""),
            }
        })
        .await;
        let reseau = Arc::new(Reseau::new());
        reseau.pour_essais(&["127.0.0.1"], 1);
        let comptes = Arc::new(Comptes::new(&d.0, Arc::new(CoffreClair), None));
        let s = SessionMs {
            name: "Ana".into(),
            uuid: "u".into(),
            xuid: "1".into(),
            refresh_token: "r".into(),
            access_token: "a".into(),
            expires_at: crate::base::maintenant() + 3_600_000,
            redirect: "native".into(),
        };
        let id = comptes.ajouter_microsoft(&s, true).unwrap().active_id.unwrap();
        let mojang = Mojang { textures: format!("{}/texture", serveur.base), ..Mojang::default() };
        let biblio = Arc::new(Bibliotheque::new(&d.0.join("skins"), &d.0.join("cache"), reseau.clone(), mojang));
        let points = Points { mc: serveur.base.clone(), ..Points::default() };
        let g = GardeRobe::new(comptes.clone(), biblio.clone(), reseau, points);

        let (lib, _) = biblio.ajouter(&png(64, 64, 9), "Mon skin", "slim").unwrap();
        let e = g.appliquer(&id, &json!({ "skin": { "library": lib.id }, "variant": "slim" })).await.unwrap();
        assert_eq!(e["account"]["look"]["skin"]["hash"], h1.as_str());
        assert_eq!(e["account"]["look"]["skin"]["libraryId"], lib.id.as_str());
        assert_eq!(e["account"]["look"]["capes"][0]["alias"], "Migrator");
        assert!(g.appliquer(&id, &json!({ "cape": "pas-a-moi" })).await.is_err());
        let e = g.appliquer(&id, &json!({ "cape": "c1" })).await.unwrap();
        assert_eq!(e["account"]["look"]["cape"]["hash"], "2".repeat(64));
        // 429 : pause de 120 s, plus aucun appel pendant ce temps.
        assert_eq!(g.appliquer(&id, &json!({ "cape": "c1" })).await.unwrap_err().code, Some("RATE_LIMIT"));
        let etat = g.instantane(&id, None);
        assert!(etat["cooldownUntil"].as_i64().unwrap() > crate::base::maintenant() + 100_000);
        let avant = serveur.nombre();
        assert_eq!(g.appliquer(&id, &json!({ "cape": null })).await.unwrap_err().code, Some("RATE_LIMIT"));
        assert_eq!(serveur.nombre(), avant);
        // Hors-ligne : pas de changement de skin.
        comptes.ajouter_hors_ligne("Bob").unwrap();
        let bob = comptes.liste().active_id.unwrap();
        assert!(g.par_defaut(&bob).await.is_err());
    }
}
