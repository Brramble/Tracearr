/**
 * Setup routes - Check if Tracearr has been configured
 */

import type { FastifyPluginAsync } from 'fastify';
import { isNotNull, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, users, settings } from '../db/schema.js';

export const setupRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /setup/status - Check Tracearr configuration status
   *
   * This endpoint is public (no auth required) so the frontend
   * can determine whether to show the setup wizard or login page.
   *
   * Returns:
   * - needsSetup: true if no owner accounts exist
   * - hasServers: true if at least one server is configured
   * - hasPasswordAuth: true if at least one user has password login enabled
   * - jellyfinAuthEnabled: true if Jellyfin authentication is enabled
   */
  app.get('/status', async () => {
    // Check for servers, users, and settings in parallel
    const [serverList, ownerList, passwordUserList, settingsRow] = await Promise.all([
      db.select({ id: servers.id }).from(servers).limit(1),
      db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1),
      db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1),
      db.select({ jellyfinAuthEnabled: settings.jellyfinAuthEnabled }).from(settings).limit(1),
    ]);

    return {
      needsSetup: ownerList.length === 0,
      hasServers: serverList.length > 0,
      hasPasswordAuth: passwordUserList.length > 0,
      jellyfinAuthEnabled: settingsRow[0]?.jellyfinAuthEnabled ?? false,
    };
  });
};
