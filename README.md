# Lagon — messagerie de groupe et privée

Lagon permet à vos membres de discuter et de partager photos et vidéos :

- **Groupe** : une discussion ouverte à tous les membres.
- **Discussions privées** : entre deux personnes. Elles sont protégées par la base de données : personne d'autre ne peut les lire, pas même le gérant.
- **Gérant** : le tout premier compte créé. Il peut supprimer les messages du groupe et bloquer un membre.

L'application est faite de 5 fichiers :

| Fichier | Rôle |
|---|---|
| `index.html` | La page de l'application |
| `style.css` | L'apparence |
| `app.js` | Le fonctionnement |
| `config.js` | L'adresse et la clé de votre projet Supabase (à remplir) |
| `supabase.sql` | La base de données et ses règles de sécurité |

---

## Étape 1 — Créer le projet Supabase (gratuit)

1. Allez sur **supabase.com** et créez un compte.
2. Cliquez sur **New project**. Donnez-lui le nom `lagon`, choisissez un mot de passe de base de données (gardez-le) et la région la plus proche.
3. Attendez une ou deux minutes que le projet soit prêt.

## Étape 2 — Installer la base de données

1. Dans le menu de gauche, ouvrez **SQL Editor**, puis **New query**.
2. Copiez tout le contenu du fichier `supabase.sql`, collez-le, puis cliquez sur **Run**.
3. Vous devez voir « Success ». Si une erreur apparaît, copiez-la et envoyez-la à Claude.

## Étape 3 — Récupérer l'adresse et la clé

1. Ouvrez **Project Settings** (roue dentée), puis **API**.
2. Copiez **Project URL** et la clé **anon public**.
3. Ouvrez `config.js` et remplacez les deux valeurs :

```js
window.LAGON_CONFIG = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
};
```

La clé « anon public » peut être visible dans le code : ce sont les règles de la base de données qui protègent les messages. Ne copiez **jamais** la clé « service_role ».

## Étape 4 — Mettre l'application en ligne

Le plus simple depuis un iPad : **GitHub Pages**.

1. Créez un dépôt GitHub nommé `lagon` et ajoutez-y les 5 fichiers.
2. Dans le dépôt : **Settings** › **Pages** › Source : *Deploy from a branch*, branche `main`, dossier `/ (root)`, puis **Save**.
3. Après une minute, votre adresse apparaît, par exemple `https://votre-nom.github.io/lagon/`.

## Étape 5 — Relier l'adresse à Supabase

Dans Supabase : **Authentication** › **URL Configuration**.

- **Site URL** : collez l'adresse de votre application (celle de l'étape 4).
- **Redirect URLs** : ajoutez la même adresse.

Sans cela, le lien de confirmation reçu par email ne ramènera pas vers Lagon.

## Étape 6 — Créer votre compte gérant

Ouvrez l'application et créez votre compte **en premier**. Le premier compte devient automatiquement gérant. Confirmez votre email, puis connectez-vous.

Ensuite, envoyez simplement l'adresse de l'application à vos membres pour qu'ils créent leur compte.

---

## Bon à savoir

- **Emails de confirmation** : le service d'email intégré de Supabase n'envoie que quelques emails par heure. C'est suffisant pour tester. Pour beaucoup d'inscriptions, il faudra brancher un service d'email (Authentication › Emails › SMTP), ou désactiver la confirmation (Authentication › Sign In / Providers › Email › *Confirm email*) si tous vos membres sont connus.
- **Limites gratuites de Supabase** : environ 1 Go de stockage pour les photos et vidéos. Chaque fichier est limité à 50 Mo. Un projet gratuit inactif pendant une semaine est mis en pause ; il suffit de le relancer depuis le tableau de bord.
- **Modération** : le gérant peut supprimer les messages du groupe et bloquer un membre (il ne peut alors plus rien envoyer, ni dans le groupe ni en privé). Les discussions privées ne sont pas lisibles par le gérant : c'est le principe d'une messagerie privée.
- **Changer de nom** : un membre ne peut modifier que son nom affiché. Personne ne peut se donner le rôle de gérant depuis l'application.
