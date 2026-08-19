# spese-app

PWA per il tracciamento delle spese personali, cifrata end-to-end.
Repo **pubblico**: contiene solo codice, mai token né passphrase né dati.

I dati vivono cifrati in un repo privato separato (`spese-data`). La chiave si
deriva da una passphrase che non lascia mai il dispositivo.

**App:** <https://andrus98.github.io/spese-app/>

## Come funziona, in breve

Tre schermate: **Nuova spesa** (griglia di categorie e tastierino),
**Riepilogo** (gli stessi KPI del vecchio foglio Excel) e **Movimenti**
(correzione ed export). Dietro l'ingranaggio: entrate, canoni ricorrenti,
backup e stato del dispositivo.

Il mese è l'unica unità temporale: il giorno non viene registrato da nessuna
parte. Ogni scrittura è un commit sul repo dati.

## Sviluppo

Non serve Node. Dalla root del repo:

```bash
python3 -m http.server 8123 --bind 127.0.0.1
```

`localhost` è un **secure context**, quindi la Web Crypto API si comporta
esattamente come in produzione, e `api.github.com` risponde con
`access-control-allow-origin: *`, quindi anche le chiamate ai dati funzionano
senza proxy.

### Test

Non c'è un runner da riga di comando (niente Node): la suite gira in un
browser vero, che è anche l'ambiente che conta. Apri **`dev/selftest.html`** —
in locale, da GitHub Pages o direttamente dall'iPhone, per verificare che
crittografia e formati si comportino allo stesso modo su tutti i dispositivi.

### Icone

```bash
pip3 install Pillow && python3 dev/make-icons.py
```

Rigenera `icons/`. Sono generate e non disegnate a mano apposta: restano
riproducibili invece di essere binari di provenienza ignota nel repo.

## Sicurezza

- **Nessun segreto qui dentro.** Il token di `spese-data` lo inserisce
  l'utente al primo avvio e resta nel `localStorage` del browser.
- La chiave AES è una `CryptoKey` con `extractable: false` in IndexedDB:
  nessun JavaScript può leggerne i byte, nemmeno questo.
- CSP senza `unsafe-inline`: è ciò che impedisce a un eventuale XSS di
  spedire il token altrove.
- I messaggi di commit sono generici: non sono cifrati, e scriverci dentro
  categoria e importo esporrebbe proprio i dati che il resto protegge.

> ⚠️ **La passphrase non è recuperabile.** Va salvata nel Portachiavi iCloud
> o in un gestore di password al momento del setup.

---

## Runbook

### Il token è scaduto o l'ho revocato

I PAT fine-grained scadono (al massimo un anno). Quando succede, ogni
scrittura fallisce con un messaggio esplicito.

1. GitHub → *Settings* → *Developer settings* → *Fine-grained tokens* → nuovo
   token su **solo `spese-data`**, permesso **Contents: Read and write**.
2. Nell'app: ingranaggio → *Dimentica questo dispositivo* → rifai il setup.
   I dati su GitHub non vengono toccati; serve di nuovo la passphrase.

### Configurare un dispositivo nuovo

Repo, token, passphrase. Se la passphrase è sbagliata l'app lo dice **al
setup**, prima di scrivere qualsiasi cosa: è a questo che serve il blocco di
verifica dentro `data/crypto.json`.

### L'app chiede di nuovo la passphrase

iOS può liberare lo storage scrivibile da script dopo un periodo di
inattività, e con esso la chiave. Repo e token restano: basta reinserire la
passphrase, che viene ri-derivata dal salt già sul repo. Nessun dato è perso.

### Recuperare i dati di una data passata

Ogni scrittura è un commit, quindi la history è un backup versionato:

```bash
git clone https://github.com/andrus98/spese-data
cd spese-data && git log --oneline -- data/2026/2026-08.json
git show <commit>:data/2026/2026-08.json > vecchio.json
```

Il file è cifrato. Per leggerlo: ingranaggio → *Importa dati* sostituisce il
mese con quel contenuto, oppure si decifra a mano con la passphrase.

### Il Riepilogo non torna con l'export Excel

Quasi sempre sono i **canoni ricorrenti**: si sommano alle transazioni della
loro categoria, quindi compaiono nei totali di mese e categoria ma non fra le
"Top 5 spese", che elencano solo spese realmente fatte. Nell'Excel il canone è
il numero in testa alla formula, per esempio `=30+SUMIF(…)`.

### Ho sbagliato mese su una spesa

Movimenti → tocca la voce → cambia il mese → *Salva*. La spesa viene spostata
fra due file: prima scritta sulla destinazione, poi rimossa dall'origine. Se
la seconda scrittura fallisce resta un duplicato — visibile e correggibile —
invece di sparire in silenzio.

### Chiudere un anno

Ingranaggio → *Chiudi l'anno*: diventa di sola lettura su **tutti** i
dispositivi, perché il blocco vive nei dati e non nel browser. Si riapre dallo
stesso posto.
