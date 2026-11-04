# Connexion Microsoft : créer l'application Azure et demander l'accès à Mojang

> Guide de l'étape 4 · rédigé le 1er novembre 2026
> Durée : environ 20 minutes de ton côté, puis **attendre la réponse de Mojang** (les demandes sont examinées chaque semaine).

## Pourquoi c'est nécessaire

Pour qu'un launcher puisse connecter un compte Microsoft à Minecraft, il lui faut un **identifiant d'application** (« client ID ») enregistré chez Microsoft **et approuvé par Mojang**.
Sans cette approbation, les serveurs Minecraft refusent la connexion (« Invalid app registration »).
Chaque launcher non officiel fait pareil, avec son propre identifiant.

Ce qui sort de ce guide : **un client ID**, qui n'est pas secret et sera écrit dans le code du launcher. Aucun mot de passe ni « secret client » n'est nécessaire.

---

## Étape A : avoir un compte Azure

Microsoft demande un compte Azure avec un abonnement actif. L'offre **gratuite** suffit : l'enregistrement d'une application ne coûte rien.

1. Va sur [azure.microsoft.com/free](https://azure.microsoft.com/pricing/purchase-options/azure-account) et clique sur **Démarrer gratuitement**.
2. Connecte-toi avec ton compte Microsoft (celui de Minecraft ou un autre, au choix).
3. Suis les étapes. Microsoft vérifie en général ton identité par téléphone et par **carte bancaire**. Rien n'est débité tant que tu restes sur l'offre gratuite.

> ⚠️ Si tu n'as pas de carte bancaire ou si tu es mineur, il faudra sans doute l'aide d'un adulte pour cette étape.
> Si tu as déjà un compte Azure, passe directement à l'étape B.

---

## Étape B : enregistrer l'application

1. Ouvre le [centre d'administration Microsoft Entra](https://entra.microsoft.com) et connecte-toi avec le même compte.
2. Dans le menu : **Entra ID** → **App registrations** (Inscriptions d'applications) → **New registration** (Nouvelle inscription).
3. Remplis :

   | Champ | Valeur |
   |---|---|
   | **Name** (Nom) | `0Rzxn_ Launcher` |
   | **Supported account types** (Types de comptes) | **Personal accounts only** (Comptes Microsoft personnels uniquement). ⚠️ C'est indispensable : les comptes Minecraft sont des comptes personnels. |
   | **Redirect URI** | laisse vide pour l'instant |

4. Clique sur **Register** (Inscrire).
5. Tu arrives sur la page **Overview** (Vue d'ensemble). Note ces 2 valeurs :
   - **Application (client) ID** : c'est le **client ID**
   - **Directory (tenant) ID** : demandé par le formulaire de Mojang

---

## Étape C : configurer l'authentification

Toujours dans ton application :

1. Menu de gauche : **Manage** → **Authentication**.
2. **Add Redirect URI** (Ajouter un URI de redirection) → choisis la tuile **Mobile and desktop applications** (Applications mobiles et de bureau).
3. Coche l'URI proposé :
   `https://login.microsoftonline.com/common/oauth2/nativeclient`
   puis **Configure**.
4. Dans les paramètres avancés de la même page, mets **Allow public client flows** (Autoriser les flux de clients publics) sur **Yes**, puis **Save**.

> Pas besoin de toucher à « Certificates & secrets » ni à « API permissions ».

---

## Étape D : demander l'accès à Mojang

1. Ouvre le formulaire officiel : [aka.ms/mce-reviewappid](https://aka.ms/mce-reviewappid) (formulaire Microsoft Forms).
2. Il demande en général :
   - le **client ID** (Application ID) ;
   - le **tenant ID** (Directory ID) ;
   - une **adresse e-mail de contact**, de préférence celle de ton compte Azure ;
   - une courte **description du projet**.
3. Pour la description, tu peux copier ce texte (en anglais, comme le formulaire) :

   > 0Rzxn_ Launcher is a small personal, non-commercial Minecraft: Java Edition launcher built with Electron. It signs players in with their own Microsoft account using the standard Xbox Live → XSTS → Minecraft services flow, only to launch the game they own, either vanilla or with mod loaders and mods they choose (Fabric, Quilt, Forge, NeoForge, Modrinth). Tokens are stored encrypted on the user's machine and are only sent to Microsoft and Minecraft services and to the local game process. No ads, no data collection.

4. Envoie le formulaire **une seule fois**. Mojang examine les demandes chaque semaine.
   Tant que la réponse n'est pas arrivée, le launcher reste utilisable avec les comptes hors-ligne déjà créés (un nouveau compte hors-ligne demande un compte Microsoft connecté).

---

## Étape E : me donner le client ID

Envoie-moi **uniquement le client ID** (Application ID), ou colle-le toi-même dans [src/main/microsoft-config.js](../src/main/microsoft-config.js) :

```js
const MICROSOFT_CLIENT_ID = 'ton-client-id-ici';
```

La connexion est déjà codée et testée (avec des réponses simulées) :

```
Fenêtre de connexion Microsoft (tenant « consumers », scopes XboxLive.signin + offline_access, PKCE)
  → jeton Microsoft + jeton de rafraîchissement (chiffrés par Windows)
  → Xbox Live → XSTS → Minecraft (login_with_xbox) → profil (pseudo, UUID)
```

- **Avant l'accord de Mojang**, la connexion s'arrête à l'étape Minecraft avec le message « Mojang n'a pas encore approuvé l'application du launcher ». C'est normal.
- **Après l'accord**, rien d'autre à faire : connecte-toi depuis la fenêtre Comptes.
- Le jeton de jeu dure 24 h. Il est renouvelé automatiquement avant chaque partie s'il expire dans moins de 10 minutes. Si le renouvellement est refusé, le compte affiche « Session expirée » avec un bouton « Se reconnecter ».

---

## Ce que tu ne dois jamais partager

- ton mot de passe Microsoft ;
- un **secret client** (« client secret ») : on n'en crée pas, et si tu en vois un, ne le copie nulle part ;
- tes codes de vérification par SMS ou e-mail.

## Sources

- [Microsoft Learn : enregistrer une application dans Microsoft Entra ID](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app) (prérequis : compte Azure avec abonnement actif, option « Personal accounts only »)
- [Microsoft Learn : ajouter un URI de redirection](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri) (plateforme « Mobile and desktop applications », URI `nativeclient`)
- [Minecraft Wiki : Microsoft authentication](https://minecraft.wiki/w/Microsoft_authentication) (formulaire de Mojang, tenant `consumers`, scope `XboxLive.signin`)
- [Guide lighty-auth](https://docs.rs/crate/lighty-auth/26.9.2/source/docs/application-id-microsoft.md) (champs du formulaire, examen hebdomadaire)
