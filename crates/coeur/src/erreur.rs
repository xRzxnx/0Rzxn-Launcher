//! Erreur du moteur : un message déjà traduit (montré tel quel à l'interface) et, parfois, un code
//! que l'appelant reconnaît (NET_INSECURE, DOWNLOAD_BAD…), comme les erreurs « code » de la version Electron.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct Erreur {
    pub message: String,
    pub code: Option<&'static str>,
    /// Statut HTTP d'une réponse refusée.
    pub statut: Option<u16>,
    /// Attente demandée par le serveur (Retry-After), en millisecondes.
    pub attendre_ms: Option<u64>,
}

impl Erreur {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, statut: None, attendre_ms: None }
    }
    pub fn code(message: impl Into<String>, code: &'static str) -> Self {
        Self { code: Some(code), ..Self::new(message) }
    }
    pub fn a_le_code(&self, code: &str) -> bool {
        self.code == Some(code)
    }
}

impl fmt::Display for Erreur {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Erreur {}

/// Erreur du système de fichiers : gardée telle quelle, avec le code IO (le téléchargement ne réessaie pas ces erreurs).
impl From<std::io::Error> for Erreur {
    fn from(e: std::io::Error) -> Self {
        Self::code(e.to_string(), "IO")
    }
}

pub type Resultat<T> = Result<T, Erreur>;
