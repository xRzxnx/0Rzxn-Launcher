//! Contexte partagé par la partie jeu : dossiers, téléchargements et listes gardées en mémoire.

use crate::chemins::Dossiers;
use crate::net::Reseau;
use crate::telechargement::Telechargeur;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct Jeu {
    pub dossiers: Dossiers,
    pub telechargeur: Arc<Telechargeur>,
    pub(crate) manifeste: Mutex<Option<Arc<Value>>>,
    /// Listes de versions des loaders, gardées 30 minutes.
    pub(crate) listes: Mutex<HashMap<String, (Instant, Value)>>,
}

impl Jeu {
    pub fn new(dossiers: Dossiers, reseau: Arc<Reseau>) -> Arc<Self> {
        Arc::new(Self { dossiers, telechargeur: Telechargeur::new(reseau), manifeste: Mutex::default(), listes: Mutex::default() })
    }
    pub fn reseau(&self) -> &Reseau {
        &self.telechargeur.reseau
    }
}
