# Réservation de stock

Mini-application de réservation de stock en TypeScript de bout en bout.
Le sujet réel de l'exercice n'est pas le CRUD : c'est **garantir qu'un article unique
ne soit jamais réservé deux fois**, y compris sous requêtes concurrentes et retries réseau.

---

## Démarrage

```bash
# terminal 1 — API (http://localhost:3000)
cd server && npm install && npm run dev

# terminal 2 — front (http://localhost:5173)
cd web && npm install && npm run dev
```

```bash
cd server
npm test        # 22 tests : validation, invariants, concurrence, idempotence
npm run race    # preuve multi-processus de la double réservation (voir plus bas)
npm run typecheck
```

Aucune base à installer : SQLite, fichier créé automatiquement dans `server/data/stock.db`,
avec 4 produits de démonstration dont un **« Dock USB-C (dernière pièce) »** à `quantity = 1`,
volontairement là pour rejouer le cas du jury.

---

## Modèle de données

```
products
  id                  INTEGER PK
  name                TEXT NOT NULL
  total_quantity      INTEGER NOT NULL CHECK (total_quantity >= 0)      -- capacité
  available_quantity  INTEGER NOT NULL CHECK (available_quantity >= 0)  -- stock réservable
  version             INTEGER NOT NULL DEFAULT 0                        -- compteur de mutations
  CHECK (available_quantity <= total_quantity)

stock_events            -- journal d'audit append-only
  id, product_id FK, kind ('RESERVE' | 'RELEASE'), quantity, created_at

idempotency_keys        -- mémoire des requêtes déjà traitées
  key PK, endpoint, request_hash, status_code, response_body, created_at
```

### Deux décisions de modélisation à expliciter

**1. `quantity` est dédoublé en `available_quantity` + `total_quantity`.**
L'énoncé expose `{ id, name, quantity }`. Un seul compteur suffit pour `reserve`, mais rend
`release` non bornée : rien n'empêche un client d'appeler `release {quantity: 1000}` et de
**fabriquer du stock**. Avec la capacité en base, `release` est bornée par
`available + q <= total`. L'API continue d'exposer `quantity` (le disponible) et ajoute `total`.

**2. Les contraintes `CHECK` sont dans le schéma, pas seulement dans le code.**
Le stock négatif est impossible **par construction**, même si un futur développeur écrit
un `UPDATE` sans garde, même via un script d'admin. C'est le filet de sécurité en dessous
de la logique applicative — la défense en profondeur, pas la défense unique.

---

## API

| Méthode | Route | Corps | Réponses |
|---|---|---|---|
| `GET` | `/products` | — | `200 { products: [...] }` |
| `POST` | `/products/:id/reserve` | `{ "quantity": 2 }` | `200` · `400` · `404` · `409` · `422` |
| `POST` | `/products/:id/release` | `{ "quantity": 2 }` | `200` · `400` · `404` · `409` · `422` |
| `GET` | `/health` | — | `200 { ok: true }` |

En-tête optionnel : `Idempotency-Key: <8..200 caractères>`.

### Codes d'erreur

Toute erreur a la même forme : `{ "error": { "code", "message", "details?" } }`.
Le `code` est stable et destiné à la machine ; le `message` à l'humain.

| HTTP | `code` | Cas |
|---|---|---|
| 400 | `VALIDATION_ERROR` | quantité non entière, ≤ 0, absente, clé inconnue dans le corps, JSON malformé, `:id` non numérique |
| 404 | `PRODUCT_NOT_FOUND` | produit inexistant |
| 409 | `INSUFFICIENT_STOCK` | réservation > disponible (inclut le perdant de la course) |
| 409 | `RELEASE_EXCEEDS_CAPACITY` | libération au-delà de la capacité |
| 422 | `IDEMPOTENCY_KEY_REUSED` | même clé, corps différent |

### Exemples réels (sortie du serveur)

```
$ curl -s localhost:3000/products
{"products":[{"id":1,"name":"Laptop Lenovo","quantity":5,"total":5,"version":0}, ...]}

$ curl -sX POST localhost:3000/products/1/reserve -H 'content-type: application/json' -d '{"quantity":2}'
{"ok":true,"operation":"reserve","quantity":2,"product":{"id":1,...,"quantity":3,"total":5,"version":1}}

$ curl -sX POST localhost:3000/products/1/reserve -H 'content-type: application/json' -d '{"quantity":99}'
{"error":{"code":"INSUFFICIENT_STOCK","message":"Stock insuffisant pour le produit 1 : 99 demande(s), 3 disponible(s).","details":{"wanted":99,"available":3}}}

$ curl -sX POST localhost:3000/products/1/reserve -H 'content-type: application/json' -d '{"quantity":-1}'
{"error":{"code":"VALIDATION_ERROR","message":"Requete invalide.","details":[{"path":"quantity","message":"Number must be greater than 0"}]}}
```

---

## 1. Concurrence

### Ce qu'il ne faut pas faire

```ts
const product = await db.findById(id);       // (1) lecture
if (product.quantity < qty) throw Refus;     // (2) décision en mémoire applicative
await db.update(id, product.quantity - qty); // (3) écriture
```

Entre (1) et (3) il existe une fenêtre. Deux requêtes peuvent **toutes les deux** lire
`quantity = 1`, **toutes les deux** passer le `if`, et **toutes les deux** écrire `0`.
Résultat : deux réservations accordées pour un seul article. Le bug ne se voit pas en test
manuel — il apparaît en production, sous charge, une fois sur mille.

Le problème n'est pas la vitesse : c'est que **la décision est prise sur une donnée déjà périmée
au moment de l'écriture**.

### Ce que fait cette implémentation

La garde vit **dans** l'instruction d'écriture — voir [`server/src/repository.ts`](server/src/repository.ts) :

```sql
UPDATE products
   SET available_quantity = available_quantity - :qty,
       version            = version + 1
 WHERE id = :id
   AND available_quantity >= :qty;   -- <<< la condition est évaluée sous le verrou d'écriture
```

Puis, côté applicatif, une seule question : **combien de lignes ont été touchées ?**

```ts
const { changes } = stmt.reserve.run({ id, qty });
if (changes === 0) { /* refus : 409, ou 404 si le produit n'existe pas */ }
```

Propriétés obtenues :

- **Pas de lecture avant décision.** Il n'y a plus de fenêtre à exploiter : lire, comparer et
  écrire sont une seule opération atomique du point de vue du moteur.
- **Pas de verrou applicatif.** Aucun mutex, aucun sémaphore, aucun état en mémoire du
  processus Node — donc l'invariant tient toujours avec N instances derrière un load balancer.
  Un `Map` de mutex par produit protégerait *un* processus et échouerait dès le deuxième pod.
- **Transactions `BEGIN IMMEDIATE`.** Le verrou d'écriture est pris dès l'ouverture, ce qui
  évite l'échec tardif d'un upgrade lecture → écriture (`SQLITE_BUSY`) quand plusieurs
  processus partagent le fichier. Avec `journal_mode = WAL` et `busy_timeout = 5000ms`,
  les writers concurrents sont sérialisés et attendus, pas rejetés.
- **Mutation du stock, écriture du journal d'audit et enregistrement de la clé d'idempotence
  sont dans la même transaction.** Impossible d'avoir un stock décrémenté sans sa trace,
  ou une clé enregistrée sans son effet.

### Transposition PostgreSQL

Le même `UPDATE ... WHERE available_quantity >= :qty` fonctionne à l'identique en Postgres,
où il s'appuie sur le verrou de ligne : le second writer bloque sur la ligne, puis
**réévalue** son prédicat sur la version validée (`EPQ`, *EvalPlanQual*) et ne touche
0 ligne. C'est le point clé : `REPEATABLE READ` seul ne suffirait pas — il faut soit
ce prédicat dans l'`UPDATE`, soit un `SELECT ... FOR UPDATE` explicite, soit `SERIALIZABLE`
avec gestion du retry. L'approche retenue est la moins coûteuse des trois et ne nécessite
aucune logique de reprise.

### Alternatives écartées, et pourquoi

| Approche | Pourquoi non |
|---|---|
| Mutex / file d'attente en mémoire Node | Ne protège qu'un seul processus ; casse au scale-out |
| Verrou optimiste `WHERE version = :v` | Correct, mais impose une boucle de retry côté client et un aller-retour de lecture. La colonne `version` est exposée pour permettre cette stratégie si un cas d'usage l'exige |
| `SELECT ... FOR UPDATE` puis `UPDATE` | Correct, mais deux allers-retours et un verrou tenu plus longtemps pour un résultat identique |
| Isolation `SERIALIZABLE` | Correct, mais déplace le problème vers la gestion des erreurs de sérialisation |

### Preuve, pas affirmation

**a) Contre-preuve unitaire** — [`test/concurrency.test.ts`](server/test/concurrency.test.ts)
rejoue l'entrelacement naïf (deux lectures avant toute écriture) et démontre qu'il tenterait
d'écrire `-1`, bloqué *in extremis* par le `CHECK`. La version gardée, elle, retourne
proprement `changes === 0`.

**b) Concurrence HTTP** — 50 clients simultanés sur un stock de 5 : exactement 5 × `200`
et 45 × `409`, stock final `0`. Idem avec des quantités hétérogènes, et avec `reserve`/`release`
entrelacés (le stock reste dans `[0, total]`).

**c) Preuve multi-processus** — `npm run race` démarre **deux processus serveur distincts**
partageant le même fichier SQLite (comme deux pods derrière un LB), remet le stock à 1 et
tire deux réservations simultanées, 20 fois :

```
tour 18 | A(3101)=409 B(3102)=200 | accordees=1 stock=0 OK
tour 19 | A(3101)=200 B(3102)=409 | accordees=1 stock=0 OK
tour 20 | A(3101)=200 B(3102)=409 | accordees=1 stock=0 OK

20 tours, 0 anomalie(s). Aucune double reservation, aucun stock negatif.
```

Le gagnant alterne entre A et B — la course est réelle, pas une sérialisation déguisée.
C'est le point important : un test qui passe *parce que* le code est mono-thread ne prouve rien.

Le front expose aussi un bouton **« Tester 2 clients simultanés »** par produit, pour
rejouer le cas du jury à la main.

---

## 2. Double réservation

Le scénario de l'énoncé — 1 article restant, Client A et Client B réservent 1 —
se résout en une phrase : **le premier `UPDATE` à obtenir le verrou d'écriture gagne,
le second voit `available_quantity = 0`, son prédicat est faux, il touche 0 ligne.**

Le perdant reçoit une réponse explicite et exploitable par le client, pas un `500` :

```json
HTTP/1.1 409 Conflict
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Stock insuffisant pour le produit 4 : 1 demande(s), 0 disponible(s).",
    "details": { "wanted": 1, "available": 0 }
  }
}
```

Trois choix délibérés sur ce refus :

- **`409 Conflict`, pas `400`.** La requête est valide ; c'est l'état de la ressource qui
  a changé. Un `400` dirait au client « ta requête est fautive », ce qui est faux et
  l'empêcherait de distinguer « corrige ton payload » de « retente plus tard ».
- **`details.available` est renvoyé**, pour que le front propose immédiatement le maximum
  réservable au lieu de faire re-deviner l'utilisateur.
- **Aucune exception levée.** Un refus métier est un chemin normal du code, tracé comme
  tel ; réserver les exceptions aux vraies anomalies garde les logs d'erreur exploitables.

Ce refus est **distinct de `404`** : après un `changes === 0`, on relit la ligne pour
savoir si la garde a joué (`409`) ou si le produit n'existe pas (`404`). Cette relecture est
dans la même transaction, donc cohérente.

---

## 3. Idempotence

### Le problème

`POST /reserve` n'est pas naturellement idempotent : deux appels décrémentent deux fois.
Or un client rejoue des requêtes en permanence, sans intention de doubler l'effet :
timeout réseau alors que le serveur avait déjà validé, double-clic, retry automatique
d'un SDK, redéploiement d'un worker au milieu d'un traitement. Sans protection, chaque
incident réseau devient une réservation fantôme.

### Le mécanisme

Le client fournit `Idempotency-Key`. Dans **une seule** transaction en écriture :

1. la clé est cherchée dans `idempotency_keys` ;
2. **absente** → la mutation est exécutée, puis la clé, le statut HTTP et le corps de
   réponse sont enregistrés ;
3. **présente, même empreinte de requête** → la réponse mémorisée est renvoyée telle quelle,
   **sans retoucher le stock**, avec l'en-tête `Idempotent-Replay: true` ;
4. **présente, empreinte différente** → `422 IDEMPOTENCY_KEY_REUSED`. Réutiliser une clé
   pour un autre corps est un bug client : le signaler vaut mieux que deviner laquelle
   des deux intentions honorer.

L'empreinte est un SHA-256 de `{ endpoint, id, quantity }`.

Vérification :

```
$ curl -sX POST .../products/2/reserve -H 'Idempotency-Key: demo-key-12345' -d '{"quantity":3}'
{"ok":true,...,"product":{...,"quantity":9,"version":1}}     # Idempotent-Replay: false

$ curl -sX POST .../products/2/reserve -H 'Idempotency-Key: demo-key-12345' -d '{"quantity":3}'
{"ok":true,...,"product":{...,"quantity":9,"version":1}}     # Idempotent-Replay: true
```

`quantity` **et** `version` sont inchangés au second appel : aucune mutation, pas seulement
un stock qui « retombe » sur la même valeur par coïncidence.

### Deux décisions à défendre

**Les refus sont mémorisés aussi.** Une clé représente *une tentative précise*, et son
verdict doit être stable : rejouer une réservation refusée renvoie le même `409`. Cela impose
que le refus commite la ligne d'idempotence — d'où le choix, dans le repository, de **retourner**
les issues métier (`{ status, body }`) au lieu de lever une exception, qui déclencherait un
rollback et perdrait la mémorisation. C'est le seul endroit du code où ce détail compte,
et c'est pour cette raison qu'il est écrit ainsi.

**La clé est portée par l'en-tête, pas par le corps.** Elle relève du transport, pas du
domaine ; le corps reste le contrat métier pur, validé en `.strict()`.

### Côté front

Une clé est générée par *intention utilisateur* (`reserve:4:1`) et **conservée tant qu'aucune
réponse définitive n'est arrivée** — voir [`web/src/App.tsx`](web/src/App.tsx). Un double-clic
ou un retry après timeout rejoue donc la même clé. Le bouton est également désactivé pendant
la requête, mais c'est un confort d'UI : la garantie, elle, est côté serveur.

### Limite assumée

Deux requêtes portant la **même clé** et parfaitement simultanées : la seconde attend le
verrou d'écriture (`BEGIN IMMEDIATE` + `busy_timeout`) puis lit la clé déjà commitée et rejoue
la réponse. Correct ici. En Postgres, la garantie viendrait de la contrainte `PRIMARY KEY`
sur `key` : la seconde transaction échouerait en violation d'unicité, à traduire en relecture
puis replay (`INSERT ... ON CONFLICT DO NOTHING` puis `SELECT`). C'est le seul point du
mécanisme à réécrire lors d'une migration.

---

## 4. Sécurité essentielle

Ce qui est en place :

- **Validation stricte au bord** (Zod) sur les params, le corps et l'en-tête. `.strict()`
  rejette les clés inconnues : pas de *mass assignment* possible si le modèle grossit.
  Le `:id` d'URL est contraint à un entier positif — un `:id` est une chaîne jusqu'à preuve
  du contraire.
- **Requêtes préparées et paramétrées** partout, préparées une seule fois au démarrage.
  Aucune concaténation de SQL : pas de surface d'injection.
- **Invariants en base** (`CHECK`, `FOREIGN KEY`) : la sécurité ne dépend pas de la
  discipline du code appelant.
- **Corps limité à 8 ko** : un `POST` de 2 Go ne fait pas tomber le processus.
- **Aucune fuite d'interne** : les erreurs inattendues sont loguées côté serveur et
  renvoyées en `500 INTERNAL_ERROR` neutre — pas de stack trace au client.
- **Erreurs typées et stables**, pour que le client ne parse jamais un message humain.

Ce qui manque **volontairement** et qui serait bloquant en production :

- **Authentification et autorisation.** Aujourd'hui n'importe qui peut appeler
  `/release` et rendre du stock qu'il n'a jamais réservé. La vraie correction n'est pas un
  middleware d'auth greffé par-dessus : c'est un changement de modèle — une réservation
  devient une **entité possédée** (`reservations(id, product_id, owner_id, quantity, status)`),
  et `release` prend un `reservationId` dont on vérifie le propriétaire. `POST /release`
  avec une quantité libre est structurellement une API de confiance.
- **Rate limiting / anti-abus.** Sans quota, un seul client peut réserver tout le stock en
  boucle. À poser par IP *et* par compte, avec un plafond par produit.
- **CORS ouvert** (`cors()` sans options) : acceptable en démo, à restreindre à une liste
  d'origines explicite.
- **HTTPS, en-têtes de sécurité** (`helmet`), secrets hors du code.
- **Journalisation structurée** avec identifiant de corrélation, sans donnée personnelle.

---

## 5. Améliorations pour la production

Par ordre de valeur décroissante :

1. **Réservations à durée de vie, plutôt qu'un compteur.** Un décrément nu ne dit pas *qui*
   a réservé ni jusqu'à quand. En production : une table `reservations` avec `status` et
   `expires_at`, le disponible devenant `total - somme des réservations actives`. Cela apporte
   l'expiration automatique des paniers abandonnés (sans quoi un stock finit gelé par des
   `reserve` jamais libérés), le `release` par identifiant, et l'historique par client.
   Le `stock_events` actuel est la première marche de cet escalier.
2. **PostgreSQL.** SQLite est le bon choix pour un exercice de 60 minutes — zéro
   installation, transactions réelles, contraintes réelles — mais il sérialise les écritures
   au niveau du fichier. La logique métier ne change pas (le même `UPDATE` conditionnel) ;
   seules l'idempotence concurrente (`ON CONFLICT`) et le pooling sont à adapter.
3. **Migrations versionnées** (`node-pg-migrate`, Prisma Migrate) au lieu du
   `CREATE TABLE IF NOT EXISTS` + seed actuel, acceptable en démo, ingérable à plusieurs.
4. **Purge des clés d'idempotence.** La table croît indéfiniment ; TTL de 24–72 h par tâche
   planifiée, et index sur `created_at`.
5. **Observabilité.** Métriques `reservations_granted` / `reservations_refused` par produit,
   histogramme de latence, alerte sur un taux de `409` anormal (signal de survente ou de
   client en boucle de retry). Sans ces métriques, une régression sur la concurrence est
   invisible.
6. **Tests de charge** (k6, autocannon) validant l'invariant sous quelques milliers de
   requêtes par seconde et sur plusieurs instances, en plus des tests fonctionnels actuels.
7. **Chemin de lecture séparé.** `GET /products` peut être mis en cache court ou servi par
   une réplique ; l'écriture, elle, reste sur le primaire. Un stock affiché avec 1 s de
   retard est acceptable — un stock *réservé* avec 1 s de retard ne l'est pas.
8. **Idempotence généralisée** et rendue obligatoire pour toute mutation, via un middleware
   plutôt que par route.
9. **Si le stock devient multi-service** (paiement, logistique), le décrément atomique ne
   suffit plus : il faut une saga avec compensation (`release` en action compensatoire) ou
   un outbox transactionnel. À ne faire que le jour où le besoin existe.

---

## Structure

```
server/
  src/
    db.ts           connexion SQLite, schéma, pragmas (WAL, busy_timeout), seed
    repository.ts   UPDATE atomiques conditionnels + idempotence transactionnelle
    schemas.ts      validation Zod (params, corps, en-tête)
    errors.ts       erreurs typées -> codes HTTP
    app.ts          routes Express + gestion centralisée des erreurs
    index.ts        bootstrap, arrêt propre
  test/
    api.test.ts          contrat, validation, invariants, idempotence
    concurrency.test.ts  cas du jury, charge concurrente, contre-preuve du naïf
  scripts/
    race.ts         preuve multi-processus (2 serveurs, 1 base, 20 tours)
web/
  src/
    api.ts          client typé
    App.tsx         liste, stock, saisie, réserver/libérer, succès/erreur, test de course
```

Choix de stack : **Express + SQLite (better-sqlite3) + Zod + Vitest** côté serveur,
**React + Vite** côté front, TypeScript `strict` des deux côtés.
`better-sqlite3` est synchrone, ce qui rend les transactions triviales à raisonner — et
l'invariant reste prouvé *à travers plusieurs processus*, ce que le mono-thread ne peut pas
expliquer à lui seul.

---

## Outils utilisés

Développé avec l'assistance de **Claude Code (Claude Opus)** : rédaction du code, des tests
et de ce README. Les décisions d'architecture — décrément atomique conditionnel plutôt que
verrou applicatif, capacité en base pour borner `release`, mémorisation des refus dans
l'idempotence, preuve multi-processus plutôt que test mono-processus — ont été prises,
challengées et vérifiées par exécution (`npm test`, `npm run race`, `curl`) avant d'être
documentées ici.
