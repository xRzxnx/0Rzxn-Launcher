//! Contexte partagé par la partie jeu : dossiers, téléchargements et listes gardées en mémoire.

use crate::chemins::Dossiers;
use crate::net::Reseau;
use crate::telechargement::Telechargeur;
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub struct Jeu {
    pub dossiers: Dossiers,
    pub telechargeur: Arc<Telechargeur>,
    pub(crate) manifeste: Mutex<Option<Arc<Value>>>,
}

impl Jeu {
    pub fn new(dossiers: Dossiers, reseau: Arc<Reseau>) -> Arc<Self> {
        Arc::new(Self { dossiers, telechargeur: Telechargeur::new(reseau), manifeste: Mutex::default() })
    }
    pub fn reseau(&self) -> &Reseau {
        &self.telechargeur.reseau
    }
}
