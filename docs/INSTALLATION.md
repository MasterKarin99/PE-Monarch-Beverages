# Installation (Docker)

Application web interne de Monarch Beverages pour :

- **déposer** les plannings éditoriaux reçus des agences (un fichier Excel par pays) ;
- les **contrôler** (marques distribuées par pays, marronniers du calendrier marketing, langue, textes à compléter) ;
- les **mettre en forme** (un fichier Excel propre par pays, visuels compris) ;
- **préparer les emails** : brouillons Outlook (.eml) avec destinataires, message et planning en pièce jointe, envoyés depuis prenom.nom@exemple.com ;
- les mettre à disposition des **bottlers**, qui ne voient et ne téléchargent que les plannings de leur pays.

Fonctionne chez n'importe quel hébergeur qui exécute Docker : serveur ou VPS (OVH, Scaleway…), serveur interne, ou plateforme comme Render ou Railway.

---

## 1. Fonctionnement

| Élément | Choix |
|---|---|
| Application | Node.js 22, une image Docker, **une seule instance** |
| Données | SQLite + fichiers dans le volume `/data` |
| HTTPS | Caddy (certificat Let's Encrypt automatique) |
| Connexion | lien de connexion à usage unique, sans mot de passe |
| Emails aux bottlers | brouillons Outlook `.eml` préparés par la plateforme |

Le traitement des fichiers Excel se fait dans le navigateur de l'utilisateur. Le serveur stocke les données, contrôle les droits et gère les connexions.

### Qui a accès à quoi

| Qui | Reconnu par | Accès |
|---|---|---|
| Équipe Monarch | `ADMIN_EMAILS` (et/ou `ADMIN_DOMAINS`) | Toute la plateforme |
| Bottlers | leur adresse dans l'onglet **Contacts** (destinataire principal ou copie) | **Espace pays** : plannings et historique de leur pays, en téléchargement uniquement |
| Toute autre adresse | — | Aucun accès (pas de lien de connexion) |

Les droits sont appliqués par le serveur : un bottler ne peut ni lire les contacts, ni télécharger le planning d'un autre pays, ni rien modifier. Retirer une adresse des Contacts lui retire l'accès immédiatement. Les connexions et les téléchargements des bottlers sont journalisés (table `audit`).

### Connexion

- Les liens sont **à usage unique**. Ouvrir le lien affiche un bouton « Se connecter » (les antivirus de messagerie qui ouvrent les liens ne les consomment donc pas).
- La session dure 30 jours (`SESSION_DAYS`), dans un cookie sécurisé (HttpOnly, Secure, SameSite).
- **Sans serveur d'envoi (SMTP)** : l'équipe génère les liens dans l'onglet Contacts (bouton **Liens d'accès**, valables 7 jours) et les transmet aux bottlers.
- **Avec SMTP** : chacun saisit son adresse sur la page de connexion et reçoit son lien (valable 30 minutes).

---

## 2. Installation sur un serveur avec un nom de domaine (recommandé)

Prérequis : un serveur Linux avec Docker et Docker Compose, les ports 80 et 443 ouverts, et un nom de domaine (par exemple `plannings.monarchbeverages.com`) qui pointe vers son adresse IP.

```bash
git clone <adresse du dépôt> plannings && cd plannings   # ou décompressez l'archive
cp .env.example .env
nano .env                       # DOMAIN, ADMIN_EMAILS (et SMTP si disponible)
docker compose up -d --build
```

Au premier démarrage, les 13 pays, leurs contacts, le calendrier 2026 des marronniers et l'expéditeur sont chargés automatiquement.

### Première connexion

Générez le lien de connexion de l'équipe :

```bash
docker compose exec app node server/index.js lien prenom.nom@exemple.com
```

Ouvrez le lien affiché, puis cliquez sur « Se connecter ».

### Donner l'accès aux bottlers

Dans **Contacts**, cliquez sur **Liens d'accès** pour un pays : un lien personnel s'affiche pour chaque adresse du pays. Transmettez-le à la personne concernée. Chaque bottler ne voit que son Espace pays.

---

## 3. Autres hébergements

**Réseau interne, sans nom de domaine** (accès en HTTP, réservé au réseau de l'entreprise) :

```bash
docker build -t plannings-editoriaux .
docker run -d --name plannings --restart unless-stopped -p 8080:8080 \
  -v plannings-data:/data \
  -e PUBLIC_URL=http://<adresse-du-serveur>:8080 \
  -e ADMIN_EMAILS=prenom.nom@exemple.com \
  plannings-editoriaux
docker exec plannings node server/index.js lien prenom.nom@exemple.com
```

N'exposez pas cette variante sur Internet : sans HTTPS, les liens et les sessions circulent en clair.

**Render, Railway ou équivalent** : déployez avec le `Dockerfile`. Configurez :

- un **disque persistant** monté sur `/data`, faute de quoi les données sont perdues à chaque redémarrage ;
- `PUBLIC_URL`, l'adresse https du service ;
- `ADMIN_EMAILS` et, si disponible, SMTP ;
- **une seule instance**.

Le lien de la première connexion s'obtient avec la commande `node server/index.js lien <adresse>` dans le shell du service.

---

## 4. Paramètres

| Paramètre | Rôle | Par défaut |
|---|---|---|
| `DOMAIN` | nom de domaine (docker compose + Caddy) | — |
| `PUBLIC_URL` | adresse publique, utilisée dans les liens de connexion | `https://${DOMAIN}` |
| `ADMIN_EMAILS` | adresses de l'équipe (accès complet) | — |
| `ADMIN_DOMAINS` | domaines de l'équipe, ex. `monarchbeverages.com` | — |
| `SESSION_DAYS` | durée de connexion | 30 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | envoi des liens de connexion (facultatif) | — |
| `DATA_DIR` | dossier des données | `/data` |
| `STORAGE_QUOTA_BYTES` | espace affiché dans l'onglet Téléchargements | 10 Go |
| `TRUST_PROXY` | `false` si l'application est exposée sans proxy | proxy de confiance |

Pour le SMTP, n'importe quel service convient : relais de votre messagerie, Brevo, Mailjet, SendGrid… Seuls les liens de connexion passent par là. Les plannings, eux, partent de votre Outlook via les brouillons `.eml`.

---

## 5. Exploitation

- **Sauvegarde** : le volume `pe-data` contient tout (`pe.db` et `assets/`). Exemple :
  `docker run --rm -v plannings_pe-data:/data -v $PWD:/b alpine tar czf /b/sauvegarde-$(date +%F).tgz -C /data .`
- **Mise à jour** : remplacez les fichiers par la nouvelle version, puis `docker compose up -d --build`. Les données sont conservées.
- **Journaux** : `docker compose logs -f app`. Sans SMTP, les liens demandés depuis la page de connexion y apparaissent aussi.
- **Une seule instance** : SQLite ne supporte pas plusieurs instances simultanées.

## 6. Test sur un poste

```bash
npm install
PUBLIC_URL=http://localhost:8080 ADMIN_EMAILS=prenom.nom@exemple.com npm start
node server/index.js lien prenom.nom@exemple.com    # dans un autre terminal
```

## 7. Structure

```
server/index.js    connexion, API, droits, pages
server/auth.js     liens de connexion, sessions, équipe / bottlers
server/store.js    SQLite + fichiers
server/mailer.js   envoi des liens de connexion (SMTP, facultatif)
server/seed.json   contacts, calendrier 2026 et expéditeur au premier démarrage
public/index.html  application (dépôt, contrôles, mise en forme, emails, espace pays)
public/login.html  page de connexion
public/hosted.js   liaison de l'application avec le serveur
Dockerfile, docker-compose.yml, Caddyfile
```
