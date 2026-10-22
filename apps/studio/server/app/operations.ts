// M8 routes in one mount: models, usage, backups, setup and project settings.

import type { Hono } from 'hono'
import type { Endpoint } from '../llm/llm.ts'
import type { StoreContext } from '../store/revisions.ts'
import { backupRoutes } from './backups.ts'
import { modelRoutes } from './models.ts'
import type { AppEnv } from './projects.ts'
import { setupRoutes } from './setup.ts'
import { usageRoutes } from './usage.ts'

export function operationsRoutes(
  app: Hono<AppEnv>,
  ctx: StoreContext,
  opts: { fallback?: Endpoint; now?: () => number; localModelHosts?: boolean } = {},
) {
  modelRoutes(app, ctx, opts.fallback, { localModelHosts: opts.localModelHosts })
  usageRoutes(app, ctx, opts.now)
  backupRoutes(app, ctx, opts.now)
  setupRoutes(app, ctx)
}
