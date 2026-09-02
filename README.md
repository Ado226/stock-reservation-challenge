# Réservation de stock

Mini-application de réservation de stock, TypeScript de bout en bout.

Le sujet réel de l'exercice n'est pas le CRUD : c'est **garantir qu'un article unique
ne soit jamais réservé deux fois**, y compris sous requêtes concurrentes, sur plusieurs
instances, et malgré les retries réseau.

---

## Démarrage

```bash
# terminal 1 — API (http://localhost:3000)
cd server && npm install && npm run dev

# terminal 2 — front (http://localhost:5173)
cd web && npm install && npm run dev
```

Si le port 3000 est occupé : `PORT=3010 npm run dev` côté serveur, et
`API_URL=http://127.0.0.1:3010 npm run dev` côté front.

```bash
cd server
npm test        # 41 tests : contrat, validation, invariants, concurrence, idempotence
npm run race    # preuve multi-processus de la double réservation
npm run typecheck
```

Aucune base à installer : SQLite, fichier créé et migré automatiquement dans
`server/data/stock.db`, avec 4 produits de démonstration dont un
**« Dock USB-C (dernière pièce) »** à `quantity = 1` — le cas du jury, rejouable
d'un clic depuis l'interface.

---

## Architecture

```
HTTP  ── app.ts ───────── middlewares (helmet, CORS, rate limit, request-id, JSON 8 ko)
      │                   routes, mapping des erreurs de transport
      │
      ├─ schemas.ts ───── validation stricte des entrées (Zod)
      ├─ presenter.ts ─── issue du domaine  ->  statut + corps HTTP
      │
Domaine ─ domain.ts ───── Product, Refusal, StockOutcome (aucune dépendance)
      │
Données ─ repository.ts ─ UPDATE atomiques conditionnels, transactions, idempotence
          db.ts ───────── connexion, pragmas, migrations versionnées, seed
```

Trois couches, une seule direction de dépendance : le transport connaît le domaine,
le domaine ne connaît personne. Concrètement :

- **`repository.ts` n'a jamais entendu parler de HTTP.** Il retourne des issues du
  domaine (`{ granted: false, refusal: { reason: 'INSUFFICIENT_STOCK', ... } }`).
  C'est `presenter.ts`, et lui seul, qui décide que cela vaut un `409`. Un repository qui
  renvoie des codes de statut est un repository qu'on ne peut plus réutiliser depuis un
  worker, une commande CLI ou un consumer de queue.
- **Un refus n'est pas une exception, c'est une valeur.** Stock insuffisant est une issue
  *prévue* du métier. Réserver les exceptions aux anomalies réelles garde les logs d'erreur
  exploitables — et rend possible la mémorisation des refus (voir idempotence).
- **Pas de couche « service » vide.** À cette taille, elle ne ferait que déléguer. La
  logique transactionnelle est là où vivent les transactions, dans le repository. Le jour
  où plusieurs agrégats doivent bouger ensemble, c'est à ce moment que la couche
  s'introduit — pas avant.

### Est-ce la bonne architecture ? Les limites, dites franchement

- **SQLite sérialise *toutes* les écritures** au niveau du fichier, là où PostgreSQL
  verrouille la ligne. L'invariant est donc garanti, mais le débit en écriture plafonne :
  deux produits différents ne peuvent pas être réservés en parallèle. C'est un plafond de
  **performance**, pas de **correction**, et c'est le bon compromis pour un exercice sans
  installation. La logique métier — le même `UPDATE` conditionnel — se transpose telle
  quelle (voir *Transposition PostgreSQL*).
- **`POST /release { quantity }` est structurellement une API de confiance.** L'énoncé
  l'impose, elle est implémentée, mais avec cette signature n'importe qui peut rendre du
  stock qu'il n'a jamais réservé. La correction n'est pas un middleware d'auth greffé
  par-dessus : c'est un changement de modèle (voir *Sécurité*).
- **`better-sqlite3` est synchrone**, donc une écriture longue bloque la boucle
  d'événements. Acceptable ici (les requêtes sont des `UPDATE` sur clé primaire, quelques
  dizaines de microsecondes) ; inacceptable avec des requêtes analytiques.

---

## Modèle de données

```
products
  id                  INTEGER PK
  name                TEXT    NOT NULL
  total_quantity      INTEGER NOT NULL CHECK (total_quantity >= 0)      -- capacité
  available_quantity  INTEGER NOT NULL CHECK (available_quantity >= 0)  -- stock réservable
  version             INTEGER NOT NULL DEFAULT 0                        -- compteur de mutations
  CHECK (available_quantity <= total_quantity)

stock_events                          -- journal d'audit append-only
  id PK, product_id FK, kind ('reserve' | 'release'), quantity, actor, created_at
  INDEX (product_id, id)

idempotency_keys                      -- mémoire des requêtes déjà traitées
  PK (actor, key), endpoint, request_hash, outcome, created_at
  INDEX (created_at)                  -- sert la purge par TTL
```

Le schéma est appliqué par des **migrations versionnées** indexées sur
`PRAGMA user_version` ([`db.ts`](server/src/db.ts)) : chaque étape est jouée une fois,
dans une transaction, dans l'ordre. On n'édite jamais une étape livrée, on en ajoute une.

### Trois décisions de modélisation à expliciter

**1. `quantity` est dédoublé en `available_quantity` + `total_quantity`.**
L'énoncé expose `{ id, name, quantity }`. Un seul compteur suffit pour `reserve`, mais rend
`release` non bornée : rien n'empêche un client d'appeler `release { quantity: 1000 }` et de
**fabriquer du stock**. Avec la capacité en base, `release` est bornée par
`available + q <= total`. L'API continue d'exposer `quantity` (le disponible) et ajoute `total`.

**2. Les invariants sont dans le schéma, pas seulement dans le code.**
Le stock négatif et le stock inventé sont impossibles **par construction** (`CHECK`), même si
un futur développeur écrit un `UPDATE` sans garde, même depuis un script d'admin. C'est le
filet sous la logique applicative — défense en profondeur, pas défense unique.

**3. `version` est exposé.** Il n'est pas utilisé pour verrouiller (le prédicat dans
l'`UPDATE` suffit), mais il permet à un client de faire du verrouillage optimiste ou du
`ETag`/`If-Match` s'il en a besoin. Il sert aussi de preuve de non-mutation : un rejeu
idempotent renvoie un `version` **identique**, pas seulement un stock qui retombe par
coïncidence sur la même valeur.

---

## API

| Méthode | Route | Corps | Réponses |
|---|---|---|---|
| `GET` | `/products` | — | `200 { products: [...] }` |
| `POST` | `/products/:id/reserve` | `{ "quantity": 2 }` | `200` · `400` · `404` · `409` · `422` · `429` |
| `POST` | `/products/:id/release` | `{ "quantity": 2 }` | `200` · `400` · `404` · `409` · `422` · `429` |
| `GET` | `/health` | — | `200 { ok: true }` |

En-têtes optionnels :

| En-tête | Rôle |
|---|---|
| `Idempotency-Key` | rend la mutation rejouable (8–200 caractères) |
| `X-Client-Id` | identité du client : cloisonne les clés d'idempotence, alimente l'audit |
| `X-Request-Id` | identifiant de corrélation ; généré et renvoyé si absent |

Réponses : `Idempotent-Replay: true|false` sur les mutations idempotentes,
`X-Request-Id` sur toutes.

### Codes d'erreur

Toute erreur a la même forme : `{ "error": { "code", "message", "details?" } }`.
Le `code` est stable et destiné à la machine, le `message` à l'humain.

| HTTP | `code` | Cas |
|---|---|---|
| 400 | `VALIDATION_ERROR` | quantité non entière / ≤ 0 / absente / non numérique, clé inconnue dans le corps, JSON malformé, `:id` non entier, clé d'idempotence mal formée |
| 404 | `PRODUCT_NOT_FOUND` | produit inexistant |
| 404 | `NOT_FOUND` | route inconnue |
| 409 | `INSUFFICIENT_STOCK` | réservation > disponible — **inclut le perdant de la course** |
| 409 | `RELEASE_EXCEEDS_CAPACITY` | libération au-delà de la capacité |
| 422 | `IDEMPOTENCY_KEY_REUSED` | même clé, requête différente |
| 429 | `RATE_LIMITED` | quota de mutations dépassé |
| 500 | `INTERNAL_ERROR` | anomalie ; loguée avec son `requestId`, jamais détaillée au client |

### Exemples réels (sortie de l'instance qui tourne)

```
$ curl -s localhost:3000/products
{"products":[{"id":1,"name":"Laptop Lenovo","quantity":5,"total":5,"version":0}, ...]}

$ curl -sX POST .../products/1/reserve -d '{"quantity":1}'
{"ok":true,"operation":"reserve","quantity":1,"product":{...,"quantity":4,"total":5,"version":1}}

$ curl -sX POST .../products/1/reserve -d '{"quantity":99}'
{"error":{"code":"INSUFFICIENT_STOCK","message":"Stock insuffisant pour le produit 1 : 99 demande(s), 4 disponible(s).","details":{"wanted":99,"available":4}}}

$ curl -sX POST .../products/1/reserve -d '{"quantity":true}'
{"error":{"code":"VALIDATION_ERROR","message":"Requete invalide.","details":[{"path":"quantity","message":"Doit etre un nombre."}]}}
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
Deux réservations accordées pour un seul article. Le bug ne se voit pas en test manuel :
il apparaît en production, sous charge, une fois sur mille.

Le problème n'est pas la vitesse, c'est que **la décision est prise sur une donnée déjà
périmée au moment de l'écriture**.

### Ce que fait cette implémentation

La garde vit **dans** l'instruction d'écriture — [`repository.ts`](server/src/repository.ts) :

```sql
UPDATE products
   SET available_quantity = available_quantity - :qty,
       version            = version + 1
 WHERE id = :id
   AND available_quantity >= :qty;   -- <<< évaluée sous le verrou d'écriture
```

Puis une seule question, côté applicatif : **combien de lignes ont été touchées ?**

```ts
const changes = stmt.reserve.run({ id, qty }).changes;
if (changes === 0) { /* refus, ou produit inexistant */ }
```

Propriétés obtenues :

- **Aucune lecture avant décision.** Il n'y a plus de fenêtre à exploiter : lire, comparer
  et écrire sont une seule opération atomique du point de vue du moteur.
- **Aucun verrou applicatif.** Pas de mutex, pas de sémaphore, aucun état en mémoire du
  processus Node — donc l'invariant tient avec N instances derrière un load balancer.
  Une `Map` de mutex par produit protégerait *un* processus et échouerait dès le deuxième pod.
- **`BEGIN IMMEDIATE`.** Le verrou d'écriture est pris dès l'ouverture de la transaction :
  pas d'échec tardif d'upgrade lecture → écriture (`SQLITE_BUSY`) quand plusieurs processus
  partagent le fichier. Avec `journal_mode = WAL` et `busy_timeout = 5000`, les écrivains
  concurrents sont **sérialisés et attendus**, pas rejetés.
- **`synchronous = FULL`.** Une réservation confirmée au client ne doit pas disparaître
  dans une coupure. Compromis débit/durabilité assumé : sur du stock, la durabilité gagne.
- **Mutation du stock, journal d'audit et clé d'idempotence dans la même transaction.**
  Impossible d'avoir un stock décrémenté sans sa trace, ou une clé sans son effet.

### Transposition PostgreSQL

Le même `UPDATE ... WHERE available_quantity >= :qty` fonctionne à l'identique, en
s'appuyant sur le verrou de ligne : le second écrivain bloque sur la ligne, puis
**réévalue** son prédicat sur la version validée (*EvalPlanQual*) et ne touche 0 ligne.
Le point clé : `REPEATABLE READ` seul ne suffirait pas — il faut soit ce prédicat dans
l'`UPDATE`, soit un `SELECT ... FOR UPDATE` explicite, soit `SERIALIZABLE` avec gestion du
retry. L'approche retenue est la moins coûteuse des trois et ne demande aucune logique de
reprise.

### Alternatives écartées, et pourquoi

| Approche | Pourquoi non |
|---|---|
| Mutex / file d'attente en mémoire Node | Ne protège qu'un processus ; casse au scale-out |
| Verrou optimiste `WHERE version = :v` | Correct, mais impose une boucle de retry côté client et un aller-retour de lecture. `version` est exposé pour qui en a besoin |
| `SELECT ... FOR UPDATE` puis `UPDATE` | Correct, mais deux allers-retours et un verrou tenu plus longtemps, pour un résultat identique |
| Isolation `SERIALIZABLE` | Correct, mais déplace le problème vers la gestion des erreurs de sérialisation |

### Preuve, pas affirmation

**a) Contre-preuve unitaire** — [`concurrency.test.ts`](server/test/concurrency.test.ts)
rejoue l'entrelacement naïf (deux lectures avant toute écriture) et démontre qu'il
tenterait d'écrire `-1`, bloqué *in extremis* par le `CHECK`. La version gardée, elle,
retourne proprement `changes === 0`.

**b) Concurrence HTTP** — 50 clients simultanés sur un stock de 5 : exactement 5 × `200`,
45 × `409`, stock final `0`, et **un seul mouvement au journal d'audit** par réservation
accordée. Idem avec des quantités hétérogènes, et avec `reserve`/`release` entrelacés
(le stock reste dans `[0, total]`).

**c) Preuve multi-processus** — `npm run race` démarre **deux processus serveur distincts**
partageant le même fichier SQLite (comme deux pods derrière un LB), remet le stock à 1 et
tire deux réservations simultanées, 20 fois :

```
tour 17 | A(3101)=409 B(3102)=200 | accordees=1 stock=0 OK
tour 18 | A(3101)=200 B(3102)=409 | accordees=1 stock=0 OK
tour 19 | A(3101)=200 B(3102)=409 | accordees=1 stock=0 OK
tour 20 | A(3101)=409 B(3102)=200 | accordees=1 stock=0 OK

20 tours, 0 anomalie(s). Aucune double reservation, aucun stock negatif.
```

Le gagnant alterne entre A et B : la course est réelle, pas une sérialisation déguisée.
C'est le point important — `better-sqlite3` étant synchrone, **un test mono-processus ne
prouverait rien**, il passerait même avec le code naïf.

Le front expose aussi un bouton **« Tester 2 clients simultanés »** par produit, pour
rejouer le cas du jury à la main.

---

## 2. Double réservation

Le scénario de l'énoncé — 1 article restant, Client A et Client B réservent 1 —
se résout en une phrase : **le premier `UPDATE` à obtenir le verrou d'écriture gagne ; le
second constate `available_quantity = 0`, son prédicat est faux, il touche 0 ligne.**

Le perdant reçoit une réponse explicite et exploitable, pas un `500` :

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

- **`409 Conflict`, pas `400`.** La requête est valide ; c'est l'état de la ressource qui a
  changé. Un `400` dirait au client « ta requête est fautive » — c'est faux, et cela
  l'empêche de distinguer « corrige ton payload » de « retente plus tard ».
- **`details.available` est renvoyé**, pour que le front propose immédiatement le maximum
  réservable au lieu de faire re-deviner l'utilisateur.
- **Aucune exception levée.** Le refus est une valeur qui traverse les couches et que
  `presenter.ts` traduit en HTTP.

Ce refus est **distinct de `404`** : après un `changes === 0`, on relit la ligne pour savoir
si la garde a joué (`409`) ou si le produit n'existe pas (`404`) — relecture dans la même
transaction, donc cohérente.

---

## 3. Idempotence

### Le problème

`POST /reserve` n'est pas naturellement idempotent : deux appels décrémentent deux fois.
Or un client rejoue des requêtes en permanence, sans vouloir doubler l'effet : timeout
réseau alors que le serveur avait déjà validé, double-clic, retry automatique d'un SDK,
redéploiement d'un worker en cours de traitement. Sans protection, chaque incident réseau
devient une réservation fantôme.

### Le mécanisme

Le client fournit `Idempotency-Key`. Dans **une seule** transaction en écriture :

1. la clé est cherchée pour ce client — la clé primaire est `(actor, key)` ;
2. **absente** → l'opération est exécutée, puis la clé et **l'issue du domaine** sont
   enregistrées ;
3. **présente, même empreinte** → l'issue mémorisée est rejouée **sans retoucher le
   stock**, avec `Idempotent-Replay: true` ;
4. **présente, empreinte différente** → `422 IDEMPOTENCY_KEY_REUSED`. Réutiliser une clé
   pour une autre requête est un bug client : le signaler vaut mieux que deviner laquelle
   des deux intentions honorer.

L'empreinte est un SHA-256 de `{ operation, id, quantity }`.

```
$ curl -sX POST .../products/2/reserve -H 'Idempotency-Key: demo-key-12345' -d '{"quantity":3}'
{"ok":true,...,"product":{...,"quantity":9,"version":1}}     # Idempotent-Replay: false

$ curl -sX POST .../products/2/reserve -H 'Idempotency-Key: demo-key-12345' -d '{"quantity":3}'
{"ok":true,...,"product":{...,"quantity":9,"version":1}}     # Idempotent-Replay: true
```

`quantity` **et** `version` sont inchangés au second appel : aucune mutation n'a eu lieu.

### Quatre décisions à défendre

**Les refus sont mémorisés aussi.** Une clé représente *une tentative précise*, et son
verdict doit être stable : rejouer une réservation refusée renvoie le même `409`. Cela
impose que le refus **commite** sa ligne d'idempotence — d'où le choix de faire du refus
une valeur retournée plutôt qu'une exception, qui déclencherait un rollback et perdrait la
mémorisation. C'est la raison d'être de `StockOutcome`.

**C'est l'issue du domaine qui est stockée, pas la réponse HTTP.** La représentation
transport peut évoluer (nouveau champ, nouveau code) sans invalider les clés déjà
enregistrées ni figer un vieux corps JSON en base.

**Les clés sont cloisonnées par client** (`PK (actor, key)`). Sans cela, deux clients
choisissant la même valeur (`"retry-1"`, un compteur…) se voleraient mutuellement leur
réponse. Un test le vérifie explicitement.

**La clé voyage dans l'en-tête, pas dans le corps.** Elle relève du transport, pas du
domaine ; le corps reste le contrat métier pur, validé en `.strict()`.

### Côté front

Une clé est générée par *intention utilisateur* (`reserve:4:1`) et **conservée tant
qu'aucune réponse définitive n'est arrivée** ([`App.tsx`](web/src/App.tsx)). Un double-clic
ou un retry après timeout rejoue donc la même clé. Le bouton est aussi désactivé pendant la
requête, mais ce n'est qu'un confort d'UI : la garantie est côté serveur.

### Limite assumée

Deux requêtes portant la **même clé** et parfaitement simultanées : la seconde attend le
verrou d'écriture (`BEGIN IMMEDIATE` + `busy_timeout`), lit la clé désormais commitée et
rejoue la réponse. Correct ici. En PostgreSQL, la garantie viendrait de la contrainte
d'unicité : la seconde transaction échouerait en violation de `PK`, à traduire en
`INSERT ... ON CONFLICT DO NOTHING` puis relecture. C'est le seul point du mécanisme à
réécrire lors d'une migration.

---

## 4. Sécurité essentielle

En place :

- **Validation stricte au bord** (Zod) sur les params, le corps et les en-têtes.
  - `.strict()` refuse les clés inconnues : pas de *mass assignment* quand le modèle grossira.
  - **Pas de `z.coerce.number()` sur la quantité.** La coercition accepterait
    `{"quantity": true}` (`Number(true) === 1`) et réserverait un article sur un booléen.
    Un test couvre ce cas, ainsi que `null`, `[1]`, `"2"` et `1.5`.
  - `:id` contraint par `^\d+$` plutôt que coercé : un paramètre de route est une chaîne
    jusqu'à preuve du contraire.
- **Requêtes préparées et paramétrées** partout, préparées une fois au démarrage. Aucune
  concaténation de SQL : pas de surface d'injection. (Le seul `PRAGMA` interpolé porte un
  entier interne de migration, jamais une donnée utilisateur.)
- **Invariants en base** (`CHECK`, `FOREIGN KEY`) : la sécurité ne dépend pas de la
  discipline du code appelant.
- **`helmet`** : en-têtes de sécurité, et `X-Powered-By` retiré (un test le vérifie).
- **Rate limiting** sur les mutations (`429 RATE_LIMITED`), `windowMs` et quota
  configurables. Les lectures restent servies. `TRUST_PROXY` permet de compter la vraie IP
  derrière un load balancer — sans quoi tout le trafic serait attribué au proxy.
- **CORS** : origines par liste blanche (`CORS_ORIGINS`), et `exposedHeaders` déclaré —
  sans cela un client cross-origin ne peut pas lire `Idempotent-Replay`.
- **Corps limité à 8 ko** : un `POST` de 2 Go ne fait pas tomber le processus.
- **Aucune fuite d'interne** : les anomalies sont loguées côté serveur avec leur
  `requestId` et renvoyées en `500 INTERNAL_ERROR` neutre. Pas de stack trace au client.
- **Journalisation structurée** (JSON, une ligne par requête) avec identifiant de
  corrélation, repris du client s'il en fournit un.

Manquant **volontairement**, et bloquant en production :

- **Authentification et autorisation.** `X-Client-Id` est déclaratif : c'est le point
  d'ancrage où une identité vérifiée (JWT, session) viendra se brancher, pas une preuve.
  Aujourd'hui n'importe qui peut appeler `/release`. La vraie correction n'est pas un
  middleware greffé par-dessus, c'est un **changement de modèle** : une réservation devient
  une entité possédée — `reservations(id, product_id, owner_id, quantity, status,
  expires_at)` — et `release` prend un `reservationId` dont on vérifie le propriétaire.
  `POST /release { quantity }` est structurellement une API de confiance ; l'énoncé l'impose,
  je l'implémente, et je le signale.
- **Quota par compte et par produit**, en plus du rate limiting par IP : sans lui, un
  client peut réserver tout le stock en boucle.
- **HTTPS obligatoire, HSTS, secrets hors du code.**
- **Audit de l'échec** : seuls les mouvements réussis sont journalisés. En production, les
  refus répétés sont un signal (client en boucle, tentative d'abus) qui mérite sa trace.

---

## 5. Améliorations pour la production

Par valeur décroissante :

1. **Réservations à durée de vie, plutôt qu'un compteur.** Un décrément nu ne dit pas *qui*
   a réservé ni jusqu'à quand. En production : une table `reservations` avec `status` et
   `expires_at`, le disponible devenant `total − somme des réservations actives`. On y gagne
   l'expiration des paniers abandonnés (sans quoi un stock finit gelé par des `reserve`
   jamais libérés), le `release` par identifiant — donc l'autorisation — et l'historique par
   client. `stock_events` est la première marche de cet escalier.
2. **PostgreSQL.** SQLite est le bon choix pour un exercice sans installation, mais il
   sérialise les écritures au niveau du fichier. La logique métier ne change pas ; seules
   l'idempotence concurrente (`ON CONFLICT`) et le pooling sont à adapter.
3. **Purge des clés d'idempotence.** La table croît indéfiniment : TTL de 24–72 h par tâche
   planifiée. L'index sur `created_at` est déjà là pour ça.
4. **Observabilité.** Métriques `reservations_granted` / `reservations_refused` par produit,
   histogramme de latence, alerte sur un taux de `409` anormal (survente, ou client en
   boucle de retry). Sans ces métriques, une régression sur la concurrence est invisible.
5. **Tests de charge** (k6, autocannon) validant l'invariant sous quelques milliers de
   requêtes par seconde et sur plusieurs instances, en complément des tests fonctionnels.
6. **Chemin de lecture séparé.** `GET /products` peut être mis en cache court ou servi par
   une réplique ; l'écriture reste sur le primaire. Un stock *affiché* avec 1 s de retard est
   acceptable — un stock *réservé* avec 1 s de retard ne l'est pas.
7. **Idempotence rendue obligatoire** pour toute mutation, via un middleware plutôt que
   route par route.
8. **CI** : `typecheck` + `test` + `race` sur chaque PR, et un linter (ESLint) que je n'ai
   pas installé ici faute de temps.
9. **Si le stock devient multi-service** (paiement, logistique), le décrément atomique ne
   suffit plus : saga avec compensation (`release` en action compensatoire) ou outbox
   transactionnel. À faire le jour où le besoin existe, pas avant.

---

## Structure

```
server/
  src/
    domain.ts       Product, Refusal, StockOutcome — zéro dépendance
    repository.ts   UPDATE atomiques conditionnels, transactions, idempotence
    presenter.ts    issue du domaine -> statut + corps HTTP (seul à connaître HTTP)
    schemas.ts      validation Zod (params, corps, en-têtes)
    db.ts           connexion, pragmas (WAL, busy_timeout, FULL), migrations, seed
    app.ts          middlewares, routes, mapping des erreurs de transport
    index.ts        bootstrap, diagnostic de démarrage, arrêt propre
  test/
    api.test.ts          contrat, validation, invariants, idempotence, garde-fous
    concurrency.test.ts  cas du jury, charge concurrente, contre-preuve du naïf
  scripts/
    race.ts         preuve multi-processus (2 serveurs, 1 base, 20 tours)
web/
  src/
    api.ts          client typé, identité de client, clés d'idempotence
    App.tsx         liste, stock, saisie, réserver/libérer, succès/erreur, test de course
```

**Stack** : Express · SQLite (`better-sqlite3`) · Zod · Vitest · React · Vite,
TypeScript `strict` (+ `noUncheckedIndexedAccess`) des deux côtés.

---

## Outils utilisés

Développé avec l'assistance de **Claude Code (Claude Opus)** : rédaction du code, des tests
et de ce README. Les décisions d'architecture — décrément atomique conditionnel plutôt que
verrou applicatif, capacité en base pour borner `release`, refus comme valeur plutôt que
comme exception, mémorisation de l'issue du domaine plutôt que de la réponse HTTP, preuve
multi-processus plutôt que test mono-processus — ont été prises, challengées, puis
**vérifiées par exécution** (`npm test`, `npm run race`, `curl`) avant d'être documentées ici.
