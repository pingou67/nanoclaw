# Mattermost — Typing indicator via REST API (not WebSocket)

## Problème

L'implémentation upstream de `setTyping` dans `src/channels/mattermost.ts` envoyait un event WebSocket `user_typing` :

```json
{ "seq": 1, "action": "user_typing", "data": { "channel_id": "...", "parent_id": "" } }
```

Les events partaient correctement (confirmé par logs), mais aucun indicateur "est en train d'écrire…" n'apparaissait côté client Mattermost.

## Cause

Mattermost filtre silencieusement les events `user_typing` envoyés via WebSocket par les **comptes bot** (créés via `POST /api/v4/bots`). Ce filtrage ne produit aucune erreur — le serveur accepte l'event mais ne le broadcaste pas aux autres clients.

## Fix

Remplacer l'envoi WS par l'API REST `POST /api/v4/users/me/typing`, qui contourne ce filtrage :

```ts
await api('POST', `/users/me/typing`, { channel_id: mmChannelId, parent_id: '' });
```

L'API REST passe par un chemin d'authentification différent côté serveur Mattermost et fonctionne pour les bots.

## Localisation

`src/channels/mattermost.ts` — méthode `setTyping` de l'adapter.

## Vigilance après `/update-nanoclaw`

Si upstream modifie `src/channels/mattermost.ts`, vérifier que la méthode `setTyping` utilise toujours `api('POST', '/users/me/typing', ...)` et non le send WS.
