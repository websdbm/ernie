import { SshDiagnosticInput, SshOperation, SshPlanInput } from '@ernie/protocol';
import { defineTool, type ToolContext, type ToolSpec } from '@ernie/tools';
import { z } from 'zod';
import { SshInventoryInput, SshInventoryResult, sshInventoryPage } from './inventory.js';
import type { SshService } from './service.js';
import { SshError } from './types.js';

const Failure = z.object({ error: z.string(), reason: z.string() });
export function createSshTools(service: SshService): ToolSpec[] {
  const call = async <T>(
    ctx: ToolContext,
    run: () => Promise<T>,
  ): Promise<T | z.infer<typeof Failure>> => {
    if (ctx.modelClass !== 'heavy')
      return {
        error: 'advanced_model_required',
        reason:
          'Le operazioni infrastruttura richiedono il modello avanzato dedicato. Nessun modello inferiore è autorizzato.',
      };
    if (!ctx.scopes.includes('chat'))
      return { error: 'scope_required', reason: 'Permesso chat richiesto.' };
    try {
      return await run();
    } catch (error) {
      return error instanceof SshError
        ? { error: error.code, reason: error.message }
        : {
            error: 'ssh_failed',
            reason: 'Richiesta non completata. Nessun segreto è stato esposto.',
          };
    }
  };
  const risk = { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false };
  return [
    defineTool({
      id: 'ssh_inventory',
      version: '1.1.0',
      category: 'ssh',
      description:
        'Legge inventario SSH dell’account: totals contiene i totali esatti, matches i risultati filtrati; servers/sites sono una pagina di massimo 10 elementi, non l’intero inventario. Usa query per cercare nome, dominio o host, serverId per un server e pagination.nextOffset per continuare. siteCount è il totale dei siti del server. Le operazioni sono solo le 5 più recenti: leggi i dettagli con ssh_operation. Nessuna credenziale privata viene esposta; non esegue modifiche.',
      risk,
      requiredScopes: ['chat'],
      inputSchema: SshInventoryInput,
      outputSchema: z.union([SshInventoryResult, Failure]),
      execute: async (input, ctx) =>
        call(ctx, async () =>
          sshInventoryPage(await service.snapshot(ctx.userId), SshInventoryInput.parse(input)),
        ),
    }),
    defineTool({
      id: 'ssh_diagnose',
      version: '1.0.0',
      category: 'ssh',
      description:
        'Diagnosi SSH in sola lettura mediante controlli fissi: overview, disco, servizi, log, Docker, WordPress. Richiede chiave installata e impronta host verificata. Non accetta comandi arbitrari.',
      risk: { ...risk, ingestsUntrusted: true },
      requiredScopes: ['chat'],
      inputSchema: SshDiagnosticInput,
      outputSchema: z.union([z.object({ output: z.string() }), Failure]),
      execute: async (input, ctx) => call(ctx, () => service.diagnose(ctx.userId, input)),
      untrustedSource: (input) => `ssh:${input.serverId}`,
    }),
    defineTool({
      id: 'ssh_plan',
      version: '1.0.0',
      category: 'ssh',
      description:
        'Crea un piano immutabile di intervento con bersaglio, motivo, comando, verifica, backup e rollback dichiarati. Non esegue nulla. Per wp_cli passa argomenti WP-CLI: percorso e container provengono dal sito. Il piano deve essere approvato personalmente nel pannello SSH; il modello non può approvarlo. Un timeout non autorizza a ripetere operazioni incerte.',
      risk: { ...risk, write: true },
      requiredScopes: ['chat'],
      inputSchema: SshPlanInput,
      outputSchema: z.union([SshOperation, Failure]),
      execute: async (input, ctx) => call(ctx, () => service.plan(ctx.userId, input)),
    }),
    defineTool({
      id: 'ssh_operation',
      version: '1.0.0',
      category: 'ssh',
      description:
        'Legge lo stato e l’esito depurato di un intervento dell’account. Non lo avvia e non lo ripete. Un riavvio accettato dal provider non dimostra che il server sia tornato online.',
      risk: { ...risk, ingestsUntrusted: true },
      requiredScopes: ['chat'],
      inputSchema: z.object({ id: z.uuid() }).strict(),
      outputSchema: z.union([SshOperation, Failure]),
      execute: async (input, ctx) => call(ctx, () => service.operation(ctx.userId, input.id)),
      untrustedSource: (input) => `ssh-operation:${input.id}`,
    }),
  ];
}
