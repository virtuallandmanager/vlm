import { engine, PlayerIdentityData, AvatarBase } from '@dcl/sdk/ecs'

/** People currently in the scene (excluding guests without an address), for the Roles picker. */
export function nearbyPlayers(): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = []
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (identity.isGuest || !identity.address) continue
    const name = AvatarBase.getOrNull(entity)?.name || `${identity.address.slice(0, 6)}…${identity.address.slice(-4)}`
    out.push({ address: identity.address.toLowerCase(), name })
  }
  return out
}
