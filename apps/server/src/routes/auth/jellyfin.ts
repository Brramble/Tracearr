/**
 * Jellyfin Authentication Routes
 *
 * POST /jellyfin/login - Login with Jellyfin credentials (no authentication required)
 * POST /jellyfin/connect-api-key - Connect a Jellyfin server with API key (requires authentication)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { servers, users, serverUsers, settings } from '../../db/schema.js';
import { JellyfinClient } from '../../services/mediaServer/index.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)
import { generateTokens, getAllServerIds } from './utils.js';
import { syncServer } from '../../services/sync.js';
import { REDIS_KEYS, CACHE_TTL } from '@tracearr/shared';

// Schema for Jellyfin login
const jellyfinLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  serverId: z.string().uuid().optional(),
});

// Schema for API key connection
const jellyfinConnectApiKeySchema = z.object({
  serverUrl: z.url(),
  serverName: z.string().min(1).max(100),
  apiKey: z.string().min(1),
});

// Rate limiting constants
const JELLYFIN_LOGIN_MAX_ATTEMPTS = 5;

export const jellyfinRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /jellyfin/login - Login with Jellyfin credentials
   * 
   * Rate limited: 5 attempts per IP per 15 minutes to prevent brute force
   */
  app.post('/jellyfin/login', async (request, reply) => {
    // Rate limiting check
    const clientIp = request.ip;
    const rateLimitKey = REDIS_KEYS.RATE_LIMIT_LOGIN(clientIp);
    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return current
    `;
    const currentCount = await app.redis.eval(luaScript, 1, rateLimitKey, CACHE_TTL.RATE_LIMIT) as number;

    if (currentCount > JELLYFIN_LOGIN_MAX_ATTEMPTS) {
      const ttl = await app.redis.ttl(rateLimitKey);
      reply.header('Retry-After', ttl.toString());
      return reply.tooManyRequests('Too many login attempts. Please try again later.');
    }

    // Validate request body
    const body = jellyfinLoginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Username and password are required');
    }

    const { username, password, serverId } = body.data;

    try {
      // Check if Jellyfin authentication is enabled
      const settingsRow = await db
        .select()
        .from(settings)
        .where(eq(settings.id, 1))
        .limit(1);

      const jellyfinAuthEnabled = settingsRow[0]?.jellyfinAuthEnabled ?? false;
      if (!jellyfinAuthEnabled) {
        return reply.forbidden('Jellyfin authentication is disabled');
      }

      // Get Jellyfin servers from database
      const jellyfinServers = await db
        .select()
        .from(servers)
        .where(eq(servers.type, 'jellyfin'));

      if (jellyfinServers.length === 0) {
        return reply.notFound('No Jellyfin servers configured');
      }

      // If serverId provided, validate it exists and is a Jellyfin server
      let targetServer;
      if (serverId) {
        targetServer = jellyfinServers.find(s => s.id === serverId);
        if (!targetServer) {
          return reply.badRequest('Invalid server ID');
        }
      } else if (jellyfinServers.length === 1) {
        // Auto-select if only one server
        targetServer = jellyfinServers[0];
      } else {
        // Multiple servers but no serverId provided
        return reply.badRequest('Server ID is required when multiple Jellyfin servers are configured');
      }

      // Authenticate with Jellyfin using the stored admin API key
      const authResult = await JellyfinClient.authenticate(
        targetServer.url,
        username,
        password
      );

      if (!authResult) {
        return reply.unauthorized('Invalid username or password');
      }

      // Check if user is an administrator
      if (!authResult.isAdmin) {
        return reply.forbidden('User must be a Jellyfin administrator');
      }

      // Check if user already exists (by email or Jellyfin external ID)
      let user;
      if (authResult.email) {
        const existingByEmail = await db
          .select()
          .from(users)
          .where(eq(users.email, authResult.email))
          .limit(1);
        user = existingByEmail[0];
      }

      // If not found by email, check by server_users external ID
      if (!user) {
        const existingServerUser = await db
          .select({
            userId: serverUsers.userId,
            user: users,
          })
          .from(serverUsers)
          .innerJoin(users, eq(serverUsers.userId, users.id))
          .where(
            and(
              eq(serverUsers.serverId, targetServer.id),
              eq(serverUsers.externalId, authResult.id)
            )
          )
          .limit(1);

        if (existingServerUser.length > 0) {
          user = existingServerUser[0]!.user;
        }
      }

      // Create new user if doesn't exist
      if (!user) {
        const [newUser] = await db
          .insert(users)
          .values({
            username: authResult.username,
            email: authResult.email,
            name: authResult.username,
            role: 'owner', // Jellyfin admins become owners
          })
          .returning();

        user = newUser!;
        app.log.info({ userId: user.id, jellyfinUserId: authResult.id }, 'New user created via Jellyfin auth');
      }

      // Check if server_users record exists for this server
      const existingServerUser = await db
        .select()
        .from(serverUsers)
        .where(
          and(
            eq(serverUsers.userId, user.id),
            eq(serverUsers.serverId, targetServer.id)
          )
        )
        .limit(1);

      if (existingServerUser.length === 0) {
        // Create server_users record
        await db
          .insert(serverUsers)
          .values({
            userId: user.id,
            serverId: targetServer.id,
            externalId: authResult.id,
            username: authResult.username,
            email: authResult.email,
            isServerAdmin: true,
          });

        app.log.info({ userId: user.id, serverId: targetServer.id }, 'Linked user to Jellyfin server');
      }

      // Trigger background sync for this server
      syncServer(targetServer.id, { syncUsers: true, syncLibraries: true })
        .then((result) => {
          app.log.info(
            { serverId: targetServer.id, usersAdded: result.usersAdded, librariesSynced: result.librariesSynced },
            'Auto-sync completed for Jellyfin server after login'
          );
        })
        .catch((error) => {
          app.log.error({ error, serverId: targetServer.id }, 'Auto-sync failed for Jellyfin server');
        });

      app.log.info({ userId: user.id, serverId: targetServer.id }, 'Jellyfin login successful');

      // Generate and return tokens
      return generateTokens(app, user.id, user.username, user.role);
    } catch (error) {
      app.log.error({ error }, 'Jellyfin login failed');
      return reply.internalServerError('Authentication failed');
    }
  });

  /**
   * POST /jellyfin/connect-api-key - Connect a Jellyfin server with API key (requires authentication)
   */
  app.post(
    '/jellyfin/connect-api-key',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = jellyfinConnectApiKeySchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('serverUrl, serverName, and apiKey are required');
      }

      const authUser = request.user;

      // Only owners can add servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only owners can add servers');
      }

      const { serverUrl, serverName, apiKey } = body.data;

      try {
        // Verify the API key has admin access
        const isAdmin = await JellyfinClient.verifyServerAdmin(apiKey, serverUrl);

        if (!isAdmin) {
          return reply.forbidden('API key does not have administrator access to this Jellyfin server');
        }

        // Create or update server
        let server = await db
          .select()
          .from(servers)
          .where(and(eq(servers.url, serverUrl), eq(servers.type, 'jellyfin')))
          .limit(1);

        if (server.length === 0) {
          const inserted = await db
            .insert(servers)
            .values({
              name: serverName,
              type: 'jellyfin',
              url: serverUrl,
              token: apiKey,
            })
            .returning();
          server = inserted;
        } else {
          const existingServer = server[0]!;
          await db
            .update(servers)
            .set({
              name: serverName,
              token: apiKey,
              updatedAt: new Date(),
            })
            .where(eq(servers.id, existingServer.id));
        }

        const serverId = server[0]!.id;

        app.log.info({ userId: authUser.userId, serverId }, 'Jellyfin server connected via API key');

        // Auto-sync server users and libraries in background
        syncServer(serverId, { syncUsers: true, syncLibraries: true })
          .then((result) => {
            app.log.info({ serverId, usersAdded: result.usersAdded, librariesSynced: result.librariesSynced }, 'Auto-sync completed for Jellyfin server');
          })
          .catch((error) => {
            app.log.error({ error, serverId }, 'Auto-sync failed for Jellyfin server');
          });

        // Return updated tokens with new server access
        return generateTokens(app, authUser.userId, authUser.username, authUser.role);
      } catch (error) {
        app.log.error({ error }, 'Jellyfin connect-api-key failed');
        return reply.internalServerError('Failed to connect Jellyfin server');
      }
    }
  );
};
