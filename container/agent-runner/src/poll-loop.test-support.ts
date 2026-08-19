/**
 * Fabrique d'`ActiveQuery` pour les tests du poll-loop.
 *
 * Pourquoi ce module existe : depuis l'ajout des requêtes d'arrière-plan, notre
 * `processQuery` prend UN descripteur `ActiveQuery` là où upstream passe encore
 * sept arguments positionnels. Chaque suite de tests reprise d'upstream doit
 * donc traduire ses appels, et le faire à la main dans chaque fichier a produit
 * une copie locale du même helper. Il vit ici pour qu'un seul endroit change le
 * jour où le descripteur évolue.
 *
 * Fichier de SUPPORT DE TEST : rien du runtime ne l'importe.
 */
import type { ActiveQuery } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';
import type { AgentQuery } from './providers/types.js';

export function makeActiveQuery(
  q: AgentQuery,
  routing: RoutingContext,
  ids: string[] = ['m1'],
  originalPrompt = 'prompt',
  initialContinuation?: string,
): ActiveQuery {
  return {
    jobId: 'fg',
    kind: 'foreground',
    query: q,
    originalPrompt,
    initialContinuation,
    startedAt: Date.now(),
    turnStartedAt: Date.now(),
    activelyProcessing: true,
    interactive: true,
    routing,
    initialBatchIds: ids,
    live: { outboundId: null, platformMsgId: null, lastUpdateAt: 0, latestText: '', eventCount: 0 },
  };
}
