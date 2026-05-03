# ShelfRx Agent — Guide d'installation pharmacie

L'agent ShelfRx est un service Windows léger qui capture vos mouvements de stock en temps réel depuis votre logiciel de gestion officinale (LGO) et les synchronise avec votre espace ShelfRx.

**Latence :** < 10 secondes entre un mouvement en pharmacie et sa réception dans ShelfRx.

---

## Prérequis

- Windows 10 ou Windows 11 (64 bits)
- Droits Administrateur sur le poste
- LGO compatible : **Winpharma** ou **LGPI/Pharmagest** (PN13), ou **LEO/Isipharm** (export CSV)
- Connexion internet (même intermittente — l'agent bufférise en local si hors ligne)

---

## Installation en 3 étapes

### Étape 1 — Télécharger l'agent

Depuis votre espace ShelfRx → **Connexion Stock** → **Agent PN13** → bouton **Télécharger l'agent**.

Vous obtenez un fichier ZIP contenant :
- `shelfrx-agent.exe` — le service Windows
- `install.bat` — le script d'installation automatique

### Étape 2 — Récupérer votre clé pharmacie

Dans ShelfRx → **Connexion Stock** → **Agent PN13** → copiez votre **Clé pharmacie** (UUID à 36 caractères).

### Étape 3 — Installer et configurer

1. **Lancez `install.bat` en tant qu'Administrateur** (clic droit → Exécuter en tant qu'administrateur)
2. Le script installe le service et ouvre le fichier de configuration `config.json` dans le Bloc-notes
3. **Collez votre clé pharmacie** dans le champ `pharmacy_key`
4. Sauvegardez le fichier (Ctrl+S)
5. Démarrez le service : `sc start ShelfRxAgent`

---

## Configuration

Le fichier de configuration se trouve dans :
`C:\Users\[votrelogin]\AppData\Roaming\ShelfRx\config.json`

```json
{
  "pn13_port": 5013,
  "cloud_url": "https://shelfrx.polsia.app",
  "pharmacy_key": "VOTRE-CLE-ICI",
  "lgo": "winpharma",
  "debug": false
}
```

| Paramètre | Description | Valeur par défaut |
|-----------|-------------|-------------------|
| `pn13_port` | Port TCP sur lequel l'agent écoute les messages PN13 | `5013` |
| `cloud_url` | URL de l'API ShelfRx | `https://shelfrx.polsia.app` |
| `pharmacy_key` | Votre clé d'authentification pharmacie **(obligatoire)** | _(vide)_ |
| `lgo` | Votre logiciel : `winpharma`, `lgpi`, `leo`, `autre` | `winpharma` |
| `debug` | Active les logs détaillés (utile pour le diagnostic) | `false` |

---

## Configuration LGO

### Winpharma

1. Ouvrez Winpharma → **Paramètres** → **Interfaces** → **PN13-IS**
2. Activez l'envoi des mouvements de stock
3. Renseignez l'adresse IP : `127.0.0.1` (si LGO et agent sur le même poste)
4. Port : `5013` (ou la valeur de `pn13_port` dans votre config)
5. Activez les types de mouvement : **Ventes**, **Réceptions**, **Retours**
6. Validez et redémarrez le module PN13

> **Astuce :** Si le LGO est sur un autre PC que l'agent, remplacez `127.0.0.1` par l'IP locale de la machine où l'agent est installé. Assurez-vous que le port 5013 est ouvert dans le pare-feu Windows de cette machine.

### LGPI / Pharmagest

1. Ouvrez LGPI → **Administration** → **Paramètres système** → **Envoi PN13**
2. Activez **Envoi PN13-IS**
3. Adresse IP : `127.0.0.1` | Port : `5013`
4. Cochez : Sorties, Entrées, Retours fournisseurs
5. Enregistrez et relancez le moteur de synchronisation

### LEO / Isipharm (mode fichier)

LEO ne supporte pas nativement PN13. L'agent utilise un observateur de fichiers CSV :

1. Dans LEO → **Export** → configurez un export automatique périodique (toutes les 5 min recommandé)
2. Choisissez le format CSV avec les colonnes : Code CIP, Libellé, Quantité, Type mouvement
3. Dans `config.json`, ajoutez :
   ```json
   "lgo": "leo",
   "leo_watch_path": "C:\\chemin\\vers\\dossier\\exports\\leo"
   ```
4. L'agent détectera automatiquement les nouveaux fichiers

---

## Vérification du fonctionnement

Après l'installation, dans ShelfRx → **Connexion Stock** → **Agent PN13** :

- Le badge **Connecté** apparaît en vert dès que l'agent envoie ses premiers événements
- Le compteur d'événements se met à jour en temps réel

Pour vérifier manuellement :
```cmd
sc query ShelfRxAgent
```
Le statut doit afficher `RUNNING`.

Les logs de l'agent se trouvent dans :
`C:\Users\[votrelogin]\AppData\Roaming\ShelfRx\agent.log`

---

## Commandes de gestion

```cmd
# Démarrer le service
sc start ShelfRxAgent

# Arrêter le service
sc stop ShelfRxAgent

# Vérifier le statut
sc query ShelfRxAgent

# Désinstaller le service
sc stop ShelfRxAgent && sc delete ShelfRxAgent
```

---

## Résolution de problèmes

| Symptôme | Cause probable | Solution |
|----------|---------------|----------|
| Badge "Non connecté" dans ShelfRx | Agent non démarré | `sc start ShelfRxAgent` |
| Service en erreur | `pharmacy_key` manquante | Vérifiez `config.json` |
| Port déjà utilisé | Un autre programme utilise le port 5013 | Changez `pn13_port` dans `config.json` et dans votre LGO |
| Événements non reçus | LGO mal configuré | Vérifiez l'IP et le port dans les paramètres PN13 du LGO |
| Events en attente côté agent | Pas de connexion internet | Normal — l'agent bufférise et renverra dès reconnexion |

---

## Sécurité

- La communication entre l'agent et ShelfRx cloud est chiffrée (HTTPS/TLS)
- La `pharmacy_key` est unique à votre pharmacie et ne doit pas être partagée
- L'agent n'envoie que les mouvements de stock (CIP, quantité, type, horodatage) — aucune donnée patient
- L'agent écoute uniquement sur `127.0.0.1` par défaut (non accessible depuis l'extérieur)

---

## Support

**Email :** support@polsia.com
**Dans l'app :** ShelfRx → Connexion Stock → Agent PN13 → bouton Support
