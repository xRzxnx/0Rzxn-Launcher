//! Historique des optimisations d'une instance, comme services/optimizations.js : chaque changement de performances
//! (mémoire, préréglage Java, priorité, arguments Java, pack Performances) est noté avec une copie de instance.json et
//! options.txt prise juste avant, dans instances/<id>/.optimisations/<copie>/. « Revenir avant ce changement » remet
//! les réglages et options.txt de cette copie, annule les changements plus récents et met à la corbeille les mods
//! qu'ils ont ajoutés.

use crate::base::Base;
use crate::contenu::Corbeille;
use crate::erreur::{Erreur, Resultat};
use crate::gestion_instances::modifier;
use crate::i18n::t;
use crate::instances::dossier;
use commun::{Instance, Reglages};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Réglages de l'instance qui comptent comme une optimisation.
pub const CLES: [&str; 4] = ["ram", "jvmPreset", "priority", "jvmArgs"];
const GARDEES: usize = 10;
/// Changements rapprochés (curseur de mémoire, saisie des arguments) : regroupés en un seul.
const FENETRE_MS: i64 = 60 * 1000;
const COPIES: &str = ".optimisations";

pub struct Optimisations<'a> {
    pub base: &'a Base,
    pub racine: &'a Path,
    pub maintenant: fn() -> i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ligne {
    pub id: i64,
    pub kind: String,
    pub created_at: i64,
    pub summary: Option<Value>,
    pub added: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Retour {
    pub instance: Instance,
    pub undone: usize,
    pub trashed: usize,
}

fn valeur(r: &Reglages, cle: &str) -> Value {
    serde_json::to_value(r).ok().and_then(|v| v.get(cle).cloned()).unwrap_or(Value::Null)
}

impl Optimisations<'_> {
    fn copies(&self, id: &str) -> PathBuf {
        dossier(self.racine, id).join(COPIES)
    }

    /// Copie de instance.json et options.txt ; renvoie le nom du dossier de la copie.
    fn copier(&self, id: &str) -> Resultat<String> {
        let base = self.copies(id);
        let date = chrono::DateTime::from_timestamp_millis((self.maintenant)()).unwrap_or_default().with_timezone(&chrono::Local);
        let tampon = date.format("%Y-%m-%d_%H-%M-%S").to_string();
        let mut nom = tampon.clone();
        let mut n = 2;
        while base.join(&nom).exists() {
            nom = format!("{tampon}-{n}");
            n += 1;
        }
        let d = base.join(&nom);
        std::fs::create_dir_all(&d)?;
        std::fs::copy(dossier(self.racine, id).join("instance.json"), d.join("instance.json"))?;
        let options = dossier(self.racine, id).join("minecraft").join("options.txt");
        if options.is_file() {
            std::fs::copy(options, d.join("options.txt"))?;
        }
        Ok(nom)
    }

    fn retirer_copie(&self, id: &str, nom: &str) {
        if !nom.is_empty() && nom.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            let _ = std::fs::remove_dir_all(self.copies(id).join(nom));
        }
    }

    /// Plus de 10 : les plus anciennes partent (copie comprise).
    fn tailler(&self, id: &str) {
        let anciennes: Vec<_> = self.base.optimisations(id).into_iter().skip(GARDEES).collect();
        for o in &anciennes {
            self.retirer_copie(id, &o.snapshot);
        }
        self.base.retirer_optimisations(&anciennes.iter().map(|o| o.id).collect::<Vec<_>>());
    }

    /// Note une optimisation avant de l'appliquer ; renvoie son identifiant (None sans base).
    pub fn noter(&self, instance: &Instance, genre: &str, resume: Option<&Value>) -> Resultat<Option<i64>> {
        if !self.base.disponible() {
            return Ok(None);
        }
        let copie = self.copier(&instance.id)?;
        let id = self.base.ajouter_optimisation(&instance.id, genre, resume, &copie, None, Some((self.maintenant)()));
        self.tailler(&instance.id);
        Ok(id)
    }

    /// Réglages sur le point de changer : note les changements de performances. Plusieurs changements en moins d'une
    /// minute n'en font qu'un (la copie d'avant le premier reste).
    pub fn reglages_changent(&self, instance: &Instance, suivants: &Reglages) -> Resultat<Option<i64>> {
        if !self.base.disponible() {
            return Ok(None);
        }
        let changes: Vec<Value> = CLES
            .iter()
            .filter_map(|c| {
                let (de, vers) = (valeur(&instance.settings, c), valeur(suivants, c));
                (de != vers).then(|| json!({ "key": c, "from": de, "to": vers }))
            })
            .collect();
        if changes.is_empty() {
            return Ok(None);
        }
        let derniere = self.base.optimisations(&instance.id).into_iter().next();
        if let Some(d) = derniere.filter(|d| d.kind == "settings" && (self.maintenant)() - d.created_at < FENETRE_MS) {
            let mut fusion: Vec<Value> = d.summary.as_ref().and_then(|s| s["changes"].as_array().cloned()).unwrap_or_default();
            for c in changes {
                match fusion.iter_mut().find(|x| x["key"] == c["key"]) {
                    Some(x) => x["to"] = c["to"].clone(),
                    None => fusion.push(c),
                }
            }
            // Revenu à la valeur de départ : ce réglage n'a plus changé.
            fusion.retain(|c| c["from"] != c["to"]);
            if fusion.is_empty() {
                self.retirer_copie(&instance.id, &d.snapshot);
                self.base.retirer_optimisations(&[d.id]);
                return Ok(None);
            }
            self.base.changer_resume_optimisation(d.id, &json!({ "changes": fusion }));
            return Ok(Some(d.id));
        }
        self.noter(instance, "settings", Some(&json!({ "changes": changes })))
    }

    /// Fichiers ajoutés par une optimisation (chemins relatifs au dossier du jeu), connus une fois appliquée.
    pub fn ajoutes(&self, id: Option<i64>, fichiers: &[String]) {
        if let Some(id) = id {
            self.base.changer_ajouts_optimisation(id, &json!(fichiers));
        }
    }

    pub fn liste(&self, instance: &str) -> Vec<Ligne> {
        self.base
            .optimisations(instance)
            .into_iter()
            .map(|o| Ligne { id: o.id, kind: o.kind, created_at: o.created_at, summary: o.summary, added: o.added })
            .collect()
    }

    /// Revient à l'état d'avant l'optimisation `id` ; les changements plus récents sont aussi annulés.
    pub fn revenir(&self, instance: &str, id: i64, corbeille: Corbeille<'_>) -> Resultat<Retour> {
        let lignes = self.base.optimisations(instance);
        let i = lignes.iter().position(|o| o.id == id).ok_or_else(|| Erreur::new(t("ipc.optimisation_introuvable")))?;
        let annulees = &lignes[..=i];
        let copie = self.copies(instance).join(&lignes[i].snapshot);
        let avant: Value =
            crate::fichiers::lire_json(&copie.join("instance.json")).ok_or_else(|| Erreur::new(t("ipc.copie_optimisation_illisible")))?;
        let dossier_jeu = dossier(self.racine, instance).join("minecraft");
        let mut jetes = 0;
        for o in annulees {
            for rel in o.added.as_array().into_iter().flatten().filter_map(Value::as_str) {
                let Ok(f) = crate::modpacks::cible_sure(&dossier_jeu, rel) else { continue };
                if f.exists() {
                    corbeille(&f)?;
                    jetes += 1;
                }
            }
        }
        let patch = json!({ "settings": avant["settings"], "loader": avant["loader"], "loaderVersion": avant["loaderVersion"] });
        let instance_remise = modifier(self.racine, instance, &patch)?;
        let options = copie.join("options.txt");
        if options.is_file() {
            std::fs::copy(options, dossier_jeu.join("options.txt"))?;
        }
        for o in annulees {
            self.retirer_copie(instance, &o.snapshot);
        }
        self.base.retirer_optimisations(&annulees.iter().map(|o| o.id).collect::<Vec<_>>());
        Ok(Retour { instance: instance_remise, undone: annulees.len(), trashed: jetes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use std::sync::atomic::{AtomicI64, Ordering};

    static HORLOGE: AtomicI64 = AtomicI64::new(1_800_000_000_000);
    fn horloge() -> i64 {
        HORLOGE.load(Ordering::SeqCst)
    }

    #[test]
    fn regroupement_et_retour_arriere() {
        let d = Dossier::nouveau("optimisations");
        let racine = d.0.join("r");
        let base = Base::ouvrir(&d.0.join("l.db"));
        let o = Optimisations { base: &base, racine: &racine, maintenant: horloge };
        let i = crate::gestion_instances::creer(
            &racine,
            &json!({ "name": "A", "version": "1.21.11", "loader": "fabric", "loaderVersion": "0.17.2" }),
            &Reglages::default(),
        )
        .unwrap();
        std::fs::write(racine.join("instances/a/minecraft/options.txt"), "fov:70").unwrap();
        let plus = Reglages { ram: 8.0, ..i.settings.clone() };
        let id = o.reglages_changent(&i, &plus).unwrap().unwrap();
        crate::gestion_instances::modifier(&racine, "a", &json!({ "settings": { "ram": 8 } })).unwrap();
        // 10 s plus tard, un autre réglage : même ligne.
        HORLOGE.fetch_add(10_000, Ordering::SeqCst);
        let i2 = crate::instances::lire(&racine, "a").unwrap();
        let zgc = Reglages { jvm_preset: "zgc".into(), ..i2.settings.clone() };
        assert_eq!(o.reglages_changent(&i2, &zgc).unwrap(), Some(id));
        let l = o.liste("a");
        assert_eq!((l.len(), l[0].summary.as_ref().unwrap()["changes"].as_array().unwrap().len()), (1, 2));

        // Le pack ajoute un mod ; plus tard, retour avant le premier changement.
        HORLOGE.fetch_add(120_000, Ordering::SeqCst);
        let pack = o.noter(&i2, "pack", None).unwrap();
        std::fs::create_dir_all(racine.join("instances/a/minecraft/mods")).unwrap();
        std::fs::write(racine.join("instances/a/minecraft/mods/sodium.jar"), "x").unwrap();
        o.ajoutes(pack, &["mods/sodium.jar".into(), "../hors.txt".into()]);
        std::fs::write(racine.join("instances/a/minecraft/options.txt"), "fov:110").unwrap();
        let corbeille = |p: &Path| -> Resultat<()> { Ok(std::fs::remove_file(p)?) };
        let r = o.revenir("a", id, &corbeille).unwrap();
        assert_eq!((r.undone, r.trashed, r.instance.settings.ram), (2, 1, 4.0));
        assert_eq!(std::fs::read_to_string(racine.join("instances/a/minecraft/options.txt")).unwrap(), "fov:70");
        assert!(o.liste("a").is_empty());
        assert!(o.revenir("a", id, &corbeille).is_err());
    }
}
