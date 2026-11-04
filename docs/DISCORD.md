# Discord Rich Presence

Pendant une partie, le launcher peut afficher sur ton profil Discord « Joue à Survie (26.3) », le loader, le nombre de mods et le temps écoulé. L'option est **désactivée par défaut** (Paramètres › Launcher › Discord).

## Comment ça marche

Le launcher ne passe pas par Internet : il parle à l'application Discord ouverte sur ton PC, par son canal local (`\\?\pipe\discord-ipc-0`). C'est Discord qui montre ensuite le statut à tes amis. Le statut est effacé dès que le jeu se ferme ; rien n'est affiché quand tu es seulement dans le launcher.

## Créer l'application Discord (une seule fois)

Discord affiche le statut au nom d'une « application » : il faut son identifiant.

1. Ouvre https://discord.com/developers/applications et connecte-toi.
2. **New Application**, nom : `0Rzxn_ Launcher` (ce nom apparaît sur le profil, au-dessus de « Survie (26.3) »). Accepte les conditions de Discord.
3. Dans **General Information**, copie l'**Application ID** (une suite de chiffres). Ce n'est pas un secret.
4. Facultatif, pour l'image : **Rich Presence › Art Assets › Add Image(s)**, choisis `build/icon.png` et nomme-la exactement `logo`. Discord met parfois quelques minutes à l'afficher.
5. Colle l'identifiant dans `src/main/discord-config.js` :

   ```js
   const DISCORD_CLIENT_ID = '123456789012345678';
   ```

6. Relance le launcher, puis active **Afficher ma partie sur Discord** dans Paramètres › Launcher.

Pour essayer un autre identifiant sans modifier le fichier : variable d'environnement `LAUNCHER_DISCORD_CLIENT_ID`.

## Ce qui est affiché

| Option « Montrer le nom de l'instance » | Liste des membres | Profil |
|---|---|---|
| Activée (par défaut) | Joue à Survie (26.3) | Survie (26.3) · Fabric · 12 mods · temps écoulé |
| Désactivée | Joue à Minecraft 26.3 | Minecraft 26.3 · temps écoulé |

Discord fermé : rien n'est envoyé ; le launcher réessaie au lancement suivant.
