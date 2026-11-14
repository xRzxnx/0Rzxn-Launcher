//! Faux serveur HTTP local pour les tests du réseau et des téléchargements (comme les serveurs node:http des tests JS).
//! Chaque connexion répond une fois puis se ferme ; le serveur compte les requêtes et les connexions simultanées.

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Requete {
    pub chemin: String,
    pub entetes: Vec<(String, String)>,
}

impl Requete {
    pub fn entete(&self, nom: &str) -> Option<&str> {
        self.entetes.iter().find(|(n, _)| n.eq_ignore_ascii_case(nom)).map(|(_, v)| v.as_str())
    }
}

pub enum Corps {
    /// Corps complet, avec Content-Length.
    Entier(Vec<u8>),
    /// Morceaux envoyés à intervalle régulier, sans longueur annoncée (fin à la fermeture).
    Lent { donnees: Vec<u8>, morceau: usize, delai: Duration },
    /// Content-Length annoncé, mais la connexion est coupée après `apres` octets.
    Coupe { donnees: Vec<u8>, longueur: usize, apres: usize },
    /// Envoie `donnees` puis ne dit plus rien, sans fermer.
    Muet(Vec<u8>),
}

pub struct Reponse {
    pub statut: u16,
    pub entetes: Vec<(String, String)>,
    pub corps: Corps,
    /// Attente avant d'envoyer les en-têtes.
    pub avant: Duration,
}

impl Reponse {
    pub fn simple(statut: u16, corps: &str) -> Self {
        Self { statut, entetes: vec![], corps: Corps::Entier(corps.as_bytes().to_vec()), avant: Duration::ZERO }
    }
    pub fn avec(mut self, nom: &str, valeur: &str) -> Self {
        self.entetes.push((nom.into(), valeur.into()));
        self
    }
}

#[derive(Default, Debug)]
pub struct Stats {
    pub requetes: Vec<Requete>,
    pub actives: usize,
    pub max_actives: usize,
}

pub struct Serveur {
    pub base: String,
    pub stats: Arc<Mutex<Stats>>,
}

impl Serveur {
    pub fn hote(&self) -> String {
        self.base.trim_start_matches("http://").to_string()
    }
    pub fn requetes(&self) -> Vec<Requete> {
        self.stats.lock().unwrap().requetes.clone()
    }
    pub fn nombre(&self) -> usize {
        self.stats.lock().unwrap().requetes.len()
    }
}

/// Lance le serveur ; `reponse(numéro de la requête à partir de 1, requête)`.
pub async fn servir(reponse: impl Fn(usize, &Requete) -> Reponse + Send + Sync + 'static) -> Serveur {
    let ecoute = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", ecoute.local_addr().unwrap());
    let stats = Arc::new(Mutex::new(Stats::default()));
    let reponse = Arc::new(reponse);
    let s = stats.clone();
    tokio::spawn(async move {
        while let Ok((mut flux, _)) = ecoute.accept().await {
            let (s, reponse) = (s.clone(), reponse.clone());
            tokio::spawn(async move {
                let mut tampon = vec![];
                let mut b = [0u8; 4096];
                while !tampon.windows(4).any(|w| w == b"\r\n\r\n") {
                    match flux.read(&mut b).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => tampon.extend_from_slice(&b[..n]),
                    }
                }
                let texte = String::from_utf8_lossy(&tampon).into_owned();
                let mut lignes = texte.split("\r\n");
                let chemin = lignes.next().unwrap_or("").split(' ').nth(1).unwrap_or("/").to_string();
                let entetes = lignes.filter_map(|l| l.split_once(':')).map(|(n, v)| (n.trim().to_string(), v.trim().to_string())).collect();
                let requete = Requete { chemin, entetes };
                let numero = {
                    let mut st = s.lock().unwrap();
                    st.requetes.push(requete.clone());
                    st.actives += 1;
                    st.max_actives = st.max_actives.max(st.actives);
                    st.requetes.len()
                };
                let r = reponse(numero, &requete);
                tokio::time::sleep(r.avant).await;
                let mut tete = format!("HTTP/1.1 {} X\r\nConnection: close\r\n", r.statut);
                for (n, v) in &r.entetes {
                    tete.push_str(&format!("{n}: {v}\r\n"));
                }
                match &r.corps {
                    Corps::Entier(d) => tete.push_str(&format!("Content-Length: {}\r\n", d.len())),
                    Corps::Coupe { longueur, .. } => tete.push_str(&format!("Content-Length: {longueur}\r\n")),
                    _ => {}
                }
                tete.push_str("\r\n");
                let _ = flux.write_all(tete.as_bytes()).await;
                match r.corps {
                    Corps::Entier(d) => {
                        let _ = flux.write_all(&d).await;
                    }
                    Corps::Lent { donnees, morceau, delai } => {
                        for m in donnees.chunks(morceau) {
                            tokio::time::sleep(delai).await;
                            if flux.write_all(m).await.is_err() {
                                break;
                            }
                        }
                    }
                    Corps::Coupe { donnees, apres, .. } => {
                        let _ = flux.write_all(&donnees[..apres.min(donnees.len())]).await;
                        let _ = flux.flush().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    Corps::Muet(d) => {
                        let _ = flux.write_all(&d).await;
                        let _ = flux.flush().await;
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    }
                }
                let _ = flux.shutdown().await;
                s.lock().unwrap().actives -= 1;
            });
        }
    });
    Serveur { base, stats }
}
