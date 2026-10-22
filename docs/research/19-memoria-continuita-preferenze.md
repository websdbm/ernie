# Memoria, continuità e preferenze operative

Implementazione del 22 ottobre 2026, derivata dalla discussione su Muffin.

## Dati canonici e affidabilità

Il Second Brain conserva i fatti nella knowledge strutturata della nota esistente.
Ogni fatto può riportare stato (da verificare, confermato, dubbio, superato),
fonte con citazione e validità. Le vecchie schede restano leggibili senza attribuire
loro conferme retroattive. Un cambiamento di valore conserva la revisione precedente
e non eredita automaticamente conferma, fonte o validità. La cronologia del fatto
è limitata a 100 revisioni con arresto conservativo; resta anche la storia Git.

La conferma via chat richiede una citazione realmente presente nel messaggio
corrente dell'utente e un riferimento di sessione prodotto dal server. Questo
controlla l'origine della citazione, non dimostra autonomamente la verità del fatto.
Le deduzioni devono essere marcate come incerte. La lettura restituisce uno stato
alla data locale; per domande storiche va considerata la data richiesta. La storia
non viene inviata al modello salvo richiesta esplicita, per ridurre ambiguità e costo.

La memoria semantica distingue ripetizione da conferma indipendente e non presenta
più un contenuto derivato dalla conversazione come citazione letterale dell'utente.
Lo snapshot esclude fatti futuri e scaduti. Luogo dei genitori, domicilio, fine di
un'attività e rientro a casa restano informazioni distinte.

## Continuità senza un nuovo archivio di attività

Ogni turno legge in parallelo alle altre fonti un contesto limitato a 3.600 caratteri:
ID, revisione, attività ancora aperte e orari dalle liste canoniche abilitate.
Un completamento o annullamento è visibile alla successiva lettura. Non vengono
create copie di task, notifiche, liste o promemoria. Al massimo tre riepiloghi di
altre chat degli ultimi 14 giorni offrono spunti pertinenti alla domanda, sempre
marcati come storici da verificare. Questi spunti conservano il taint di contenuto
derivato: non autorizzano azioni. Prima di modificare una lista va riletta la sua
revisione corrente; per più destinazioni plausibili va proposta una scelta chiusa.
Le letture hanno statement timeout e gli errori delle fonti facoltative non bloccano
la risposta. Nessuna chiamata LLM aggiuntiva per comporre questo contesto.

## Come lavora Ernie

Una sezione nelle impostazioni consente di aggiungere, modificare, disattivare e
cancellare fino a 30 preferenze per account. Sono salvate atomicamente in
users.settings.operatingPreferences, senza sovrascrivere le altre impostazioni.
Gli strumenti permettono le stesse operazioni in chat: testo e citazione delle
preferenze esplicite devono corrispondere al messaggio originale. Le indicazioni
solo temporanee non diventano regole persistenti. Le deduzioni restano inattive
e non possono sovrascrivere una preferenza esplicita, nemmeno se disattivata.
Rimozione e disattivazione via chat richiedono un riferimento testuale preciso;
nei casi ambigui si chiede quale preferenza. L'interfaccia usa invece l'ID.

Solo le preferenze esplicite attive entrano nel contesto, per massimo 2.400 caratteri.
Sono personalizzazione e non autorizzazioni: non estendono permessi SSH o delle
skill, non disattivano conferme e non abilitano notifiche. Le rotte richiedono scope
chat e impediscono accesso incrociato fra account.

## Consolidamento ed economia

Rimane il consolidamento locale dopo l'aggiunta o modifica. La revisione generale
rispetta il limite di una volta ogni 24 ore. Il modello viene consultato solo se
ci sono versioni di note non ancora revisionate; il passare di un altro giorno
non basta a richiamarlo su dati invariati. I vault grandi possono proseguire per
lotti nelle revisioni successive. Backup, controlli contro modifiche concorrenti
e conservazione delle fonti restano attivi.

## Verifica e limiti

Test unitari, PostgreSQL/RLS e Redis isolati; test nativi SwiftUI e ispezione delle
anteprime chiare, scure e con caratteri accessibili. Il percorso reale HTTPS e
WebSocket deve essere verificato con account sintetici prima della distribuzione.
Risultati effettivi e commit della release sono in docs/releases/build-96.md.

Questa versione non introduce iniziative autonome fuori dalla conversazione né
un generatore di notifiche: usa il contesto pertinente per rispondere e proporre
passi utili. Una fonte incerta resta tale; nessun ricordo viene reso vero per
ripetizione o perché il modello ne è convinto.
