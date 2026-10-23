# Procedure diagnostiche SSH

## Dominio non raggiungibile — `site_unreachable_v1`

Disponibile agli account con skill **Server e siti** attivata. Il backend usa
il modello avanzato anche per una frase come «example.it non risponde» e carica
la procedura SSH, indipendentemente da una classificazione generica del router.
Non sono necessarie modifiche iOS: le domande usano i pulsanti `present_choices`.

1. `ssh_investigate` cerca il dominio nell'inventario dell'account autenticato.
   Corrispondenza esatta prima dell'alias www; mai deduzione del proprietario da IP,
   DNS o CDN. Più registrazioni richiedono una scelta esplicita del sito. Un ID
   estraneo non autorizza accesso e un dominio sconosciuto non avvia connessioni.
2. Il runbook esegue in parallelo DNS/HTTP/HTTPS e diagnosi SSH `overview`.
   Usa la chiave già configurata e l'impronta approvata. Non installa chiavi e non
   accetta nuove impronte automaticamente.
3. Se SSH riesce raccoglie disco/inode e servizi running/failed, con al massimo
   due controlli SSH concorrenti. Altrimenti legge soltanto lo stato dell'istanza
   provider già collegata e associata; non ne sceglie una per somiglianza.
4. Il risultato porta versione della procedura, ora, sito/server, controlli e
   limiti. `complete` significa raccolta conclusa, **non assenza di problemi**.
   Il modello distingue osservazioni, ipotesi e verifiche ancora necessarie.
5. Una domanda chiusa presenta 2–4 alternative pertinenti: approfondire una
   diagnosi, preparare un intervento motivato oppure fermarsi. È possibile
   rispondere liberamente. Preparare un piano non autorizza l'esecuzione:
   resta necessaria l'approvazione personale in **Server e siti → Proposte**.

### Limiti e controlli

- Verifica pubblica dal backend: DNS A/AAAA, HEAD alla sola radice sulle porte
  80/443, senza credenziali, corpo, query né redirect. Indirizzi privati, loopback,
  link-local e Tailscale sono esclusi dalle richieste web. Tutte le risposte DNS
  vengono controllate e la connessione resta fissata al primo indirizzo pubblico;
  non è un controllo completo di tutte le destinazioni IPv4/IPv6.
- TLS mantiene la verifica standard di hostname/certificato. Non viene disattivata
  per aggirare errori. HEAD non prova login, pagine interne o funzionamento applicativo.
- Sui server la fase iniziale non legge log o configurazioni. Log/Docker/WordPress
  restano approfondimenti espliciti mediante `ssh_diagnose`. Su Docker rootless
  i controlli del demone di root possono non vedere i container dell'utente.
- Il runbook non crea piani, non esegue backup, non riavvia, non cancella, non
  modifica servizi o associazioni. Ogni diagnosi SSH mantiene l'audit esistente;
  il risultato tool è registrato nella conversazione con output limitato e depurato.
- Durata massima del runbook 90 secondi; DNS limitato e HTTP massimo 8 secondi.
  Nessun retry automatico dell'intera procedura, risultato riutilizzato per
  chiamate identiche nello stesso turno, propagazione dell'annullamento a SSH.
- Output remoto e nomi nell'inventario sono dati, mai istruzioni operative.

## Verifica del 23 ottobre 2026

Test automatici su selezione ambigua, sito estraneo/sconosciuto, dominio con
credenziali, indirizzi privati, IP fissato senza redirect, guasti SSH e provider,
annullamento, modello avanzato e caricamento della procedura anche se il router
propone una conversazione generica. Controllo reale del probe pubblico sul dominio
API Ernie: DNS risolto, HTTP 308, HTTPS 404 alla radice (la radice non è un endpoint
applicativo); nessun redirect seguito. Verifiche di rilascio riportate sotto.
