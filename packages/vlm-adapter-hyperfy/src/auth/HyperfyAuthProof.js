/**
 * HyperfyAuthProof — Authentication proof for Hyperfy worlds.
 *
 * Hyperfy uses world.http() for authenticated requests. The adapter passes
 * the world reference as a platform-token proof so vlm-client can use it
 * to authenticate with the VLM API.
 */

export class HyperfyAuthProof {
  /**
   * Create an auth proof from a Hyperfy world instance.
   * @param {object} world — Hyperfy world instance from useWorld()
   * @returns {Promise<{ type: string, payload: object }>}
   */
  static async create(world) {
    return {
      type: 'platform-token',
      payload: {
        platform: 'hyperfy',
        worldSlug: world.getSlug?.() || '',
        shard: world.getShard?.() || '',
      },
    }
  }
}
