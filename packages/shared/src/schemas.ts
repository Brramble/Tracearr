/**
 * Zod validation schemas for API requests
 */

import { z } from 'zod';

// Common schemas
export const uuidSchema = z.uuid();
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// Auth schemas
export const loginSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    email: z.string().email(),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal('plex'),
  }),
  z.object({
    type: z.literal('jellyfin'),
    username: z.string().min(1),
    password: z.string().min(1),
    serverId: z.string().uuid().optional(),
  }),
]);

export const callbackSchema = z.object({
  code: z.string().optional(),
  token: z.string().optional(),
  serverType: z.enum(['plex', 'jellyfin', 'emby']),
});

// Server schemas
export const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['plex', 'jellyfin', 'emby']),
  url: z.url(),
  token: z.string().min(1),
});

export const serverIdParamSchema = z.object({
  id: uuidSchema,
});

// User schemas
export const updateUserSchema = z.object({
  allowGuest: z.boolean().optional(),
  trustScore: z.number().int().min(0).max(100).optional(),
});

export const userIdParamSchema = z.object({
  id: uuidSchema,
});

// Session schemas
export const sessionQuerySchema = paginationSchema.extend({
  serverUserId: uuidSchema.optional(),
  serverId: uuidSchema.optional(),
  state: z.enum(['playing', 'paused', 'stopped']).optional(),
  mediaType: z.enum(['movie', 'episode', 'track']).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const sessionIdParamSchema = z.object({
  id: uuidSchema,
});

// Session termination schema
export const terminateSessionBodySchema = z.object({
  /** Optional message to display to user (Plex only, ignored by Jellyfin/Emby) */
  reason: z.string().max(500).optional(),
});

// Rule schemas
export const impossibleTravelParamsSchema = z.object({
  maxSpeedKmh: z.number().positive().default(500),
  ignoreVpnRanges: z.boolean().optional(),
});

export const simultaneousLocationsParamsSchema = z.object({
  minDistanceKm: z.number().positive().default(100),
});

export const deviceVelocityParamsSchema = z.object({
  maxIps: z.number().int().positive().default(5),
  windowHours: z.number().int().positive().default(24),
});

export const concurrentStreamsParamsSchema = z.object({
  maxStreams: z.number().int().positive().default(3),
});

export const geoRestrictionParamsSchema = z.object({
  blockedCountries: z.array(z.string().length(2)).default([]),
});

export const ruleParamsSchema = z.union([
  impossibleTravelParamsSchema,
  simultaneousLocationsParamsSchema,
  deviceVelocityParamsSchema,
  concurrentStreamsParamsSchema,
  geoRestrictionParamsSchema,
]);

export const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum([
    'impossible_travel',
    'simultaneous_locations',
    'device_velocity',
    'concurrent_streams',
    'geo_restriction',
  ]),
  params: z.record(z.string(), z.unknown()),
  serverUserId: uuidSchema.nullable().default(null),
  isActive: z.boolean().default(true),
});

export const updateRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

export const ruleIdParamSchema = z.object({
  id: uuidSchema,
});

// Violation schemas
export const violationQuerySchema = paginationSchema.extend({
  serverId: uuidSchema.optional(),
  serverUserId: uuidSchema.optional(),
  ruleId: uuidSchema.optional(),
  severity: z.enum(['low', 'warning', 'high']).optional(),
  acknowledged: z.coerce.boolean().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const violationIdParamSchema = z.object({
  id: uuidSchema,
});

// Stats schemas
export const serverIdFilterSchema = z.object({
  serverId: uuidSchema.optional(),
});

export const statsQuerySchema = z
  .object({
    period: z.enum(['day', 'week', 'month', 'year', 'all', 'custom']).default('week'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverId: uuidSchema.optional(),
  })
  .refine(
    (data) => {
      // Custom period requires both dates
      if (data.period === 'custom') {
        return data.startDate && data.endDate;
      }
      return true;
    },
    { message: 'Custom period requires startDate and endDate' }
  )
  .refine(
    (data) => {
      // If dates provided, start must be before end
      if (data.startDate && data.endDate) {
        return new Date(data.startDate) < new Date(data.endDate);
      }
      return true;
    },
    { message: 'startDate must be before endDate' }
  );

// Location stats with full filtering - uses same period system as statsQuerySchema
export const locationStatsQuerySchema = z
  .object({
    period: z.enum(['day', 'week', 'month', 'year', 'all', 'custom']).default('month'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverUserId: uuidSchema.optional(),
    serverId: uuidSchema.optional(),
    mediaType: z.enum(['movie', 'episode', 'track']).optional(),
  })
  .refine(
    (data) => {
      if (data.period === 'custom') {
        return data.startDate && data.endDate;
      }
      return true;
    },
    { message: 'Custom period requires startDate and endDate' }
  )
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.startDate) < new Date(data.endDate);
      }
      return true;
    },
    { message: 'startDate must be before endDate' }
  );

// Webhook format enum
export const webhookFormatSchema = z.enum(['json', 'ntfy', 'apprise']);

// Settings schemas
export const updateSettingsSchema = z.object({
  allowGuestAccess: z.boolean().optional(),
  discordWebhookUrl: z.url().nullable().optional(),
  customWebhookUrl: z.url().nullable().optional(),
  webhookFormat: webhookFormatSchema.nullable().optional(),
  ntfyTopic: z.string().max(200).nullable().optional(),
  // Poller settings
  pollerEnabled: z.boolean().optional(),
  pollerIntervalMs: z.number().int().min(5000).max(300000).optional(),
  // Tautulli integration
  tautulliUrl: z.url().nullable().optional(),
  tautulliApiKey: z.string().nullable().optional(),
  // Network/access settings
  externalUrl: z.url().nullable().optional(),
  basePath: z.string().max(100).optional(),
  trustProxy: z.boolean().optional(),
  // Authentication
  jellyfinAuthEnabled: z.boolean().optional(),
});

// Tautulli import schemas
export const tautulliImportSchema = z.object({
  serverId: uuidSchema, // Which Tracearr server to import into
});

// Type exports from schemas
export type LoginInput = z.infer<typeof loginSchema>;
export type CallbackInput = z.infer<typeof callbackSchema>;
export type CreateServerInput = z.infer<typeof createServerSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SessionQueryInput = z.infer<typeof sessionQuerySchema>;
export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
export type ViolationQueryInput = z.infer<typeof violationQuerySchema>;
export type ServerIdFilterInput = z.infer<typeof serverIdFilterSchema>;
export type StatsQueryInput = z.infer<typeof statsQuerySchema>;
export type LocationStatsQueryInput = z.infer<typeof locationStatsQuerySchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type TautulliImportInput = z.infer<typeof tautulliImportSchema>;
