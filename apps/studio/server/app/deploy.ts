// Deployment routes (M7.5 to M7.6; plan §10.4, §13.6): the pairing wizard, certificates, Admin
// decisions on address requests, and Site settings > Languages. Admin only, except the two
// read-only "my project" routes the Creator's screens use. No screens here: server only.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  AddressError,
  approvedAddresses,
  decideAddressWithStepUp,
  listAddressRequests,
} from '../deploy/address.ts'
import {
  type CertDeps,
  type Issuer,
  listCertificates,
  maintainCertificates,
} from '../deploy/certs.ts'
import type { Notify } from '../deploy/hooks.ts'
import { getSiteLanguages, LanguagesError, setSiteLanguages } from '../deploy/languages.ts'
import {
  appPublicKeys,
  confirmPairing,
  connectTarget,
  listTargets,
  type PairingDeps,
  PairingError,
  pinHost,
  preparePairing,
  refreshTarget,
} from '../deploy/pairing.ts'
import type { MailDeps } from '../mail/send.ts'
import type { WebAuthnDeps } from '../release/signing.ts'
import type { StoreContext } from '../store/revisions.ts'
import { canSee } from './access.ts'
import type { AppEnv } from './projects.ts'

export type DeployOptions = {
  /** The app's address: the origin and rpId the pairing file carries. */
  appUrl: URL
  now?: () => Date
  /** Development and tests only: targets that are two local folders. */
  allowFolder?: boolean
  /** Where certificates come from. None: requests are recorded as failed ("no issuer"). */
  issuer?: Issuer | null
  notify?: Notify
  /** Mail is optional; without it the in-app inbox is all there is. */
  mail?: MailDeps | null
  /** The passkey step-up's origin, rpId and clock; by default from `appUrl` and the real clock. */
  webauthn?: WebAuthnDeps
}

type Body = Record<string, unknown>

export function certDepsOf(ctx: StoreContext, o: DeployOptions): CertDeps {
  return {
    ctx,
    issuer: o.issuer ?? null,
    now: o.now,
    notify: o.notify,
    mail: o.mail === undefined ? { appOrigin: o.appUrl.origin } : o.mail,
  }
}

export function deployRoutes(app: Hono<AppEnv>, ctx: StoreContext, o: DeployOptions) {
  const pairing: PairingDeps = { ctx, appUrl: o.appUrl, now: o.now, allowFolder: o.allowFolder }
  const certs = certDepsOf(ctx, o)
  const webauthn: WebAuthnDeps = o.webauthn ?? {
    appOrigin: o.appUrl.origin,
    rpId: o.appUrl.hostname,
    now: Date.now,
  }

  const adminOnly = (c: Context<AppEnv>): Response | null =>
    c.get('user').role === 'admin' ? null : (c.json({ code: 'forbidden' }, 403) as Response)
  const body = async (c: Context<AppEnv>) => (await c.req.json().catch(() => ({}))) as Body

  // One place turns a refusal into a response, so no route leaks a stack or an internal message.
  const guard = async (c: Context<AppEnv>, run: () => Promise<Response> | Response) => {
    try {
      return await run()
    } catch (e) {
      if (e instanceof PairingError || e instanceof AddressError || e instanceof LanguagesError)
        return c.json({ code: e.code, message: e.message }, e.status)
      throw e
    }
  }

  app.use(
    '/api/deploy/*',
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )
  app.use(
    '/api/admin/addresses/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )
  app.use(
    '/api/admin/languages/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  // ---- pairing wizard ---------------------------------------------------------------------

  app.get('/api/deploy/keys', async (c) => {
    const no = adminOnly(c)
    if (no) return no
    return c.json({ keys: await appPublicKeys(ctx) })
  })

  app.get('/api/deploy/targets', (c) => adminOnly(c) ?? c.json({ targets: listTargets(ctx) }))

  app.post(
    '/api/deploy/targets/:target/connect',
    (c) =>
      adminOnly(c) ??
      guard(c, async () =>
        c.json(await connectTarget(pairing, { ...(await body(c)), target: c.req.param('target') })),
      ),
  )

  app.post(
    '/api/deploy/targets/:target/pin-host',
    (c) =>
      adminOnly(c) ??
      guard(c, async () =>
        c.json({
          target: pinHost(pairing, c.req.param('target') ?? '', (await body(c)).fingerprint),
        }),
      ),
  )

  app.post(
    '/api/deploy/targets/:target/pairing/prepare',
    (c) =>
      adminOnly(c) ??
      guard(c, async () =>
        c.json(
          await preparePairing(pairing, c.get('user'), c.req.param('target') ?? '', {
            policy: (await body(c)).policy,
          }),
        ),
      ),
  )

  app.post(
    '/api/deploy/targets/:target/pairing/confirm',
    (c) =>
      adminOnly(c) ??
      guard(c, async () => {
        const b = await body(c)
        // Either the flat fields, or a browser PublicKeyCredential as JSON (rawId + response).
        const r = (b.response ?? null) as Body | null
        const assertion = r
          ? {
              adminKeyId: b.rawId,
              authenticatorData: r.authenticatorData,
              clientDataJSON: r.clientDataJSON,
              signature: r.signature,
            }
          : b
        return c.json(
          await confirmPairing(pairing, c.get('user'), c.req.param('target') ?? '', assertion),
        )
      }),
  )

  app.post(
    '/api/deploy/targets/:target/refresh',
    (c) =>
      adminOnly(c) ??
      guard(c, async () => {
        const target = c.req.param('target') ?? ''
        const r = await refreshTarget(pairing, target)
        // Once paired, requests already waiting in the outbox (made at first start) are picked up.
        if (r.target.status === 'paired') await maintainCertificates(certs)
        return c.json(r)
      }),
  )

  // ---- certificates -----------------------------------------------------------------------

  app.get(
    '/api/deploy/certificates',
    (c) => adminOnly(c) ?? c.json({ certificates: listCertificates(ctx) }),
  )

  app.post(
    '/api/deploy/certificates/run',
    (c) => adminOnly(c) ?? guard(c, async () => c.json(await maintainCertificates(certs))),
  )

  // ---- address requests (Admin decides; the Creator reads the answer) -----------------------

  app.get(
    '/api/admin/addresses',
    (c) =>
      adminOnly(c) ??
      guard(c, async () => {
        const status = c.req.query('status')
        if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status))
          return c.json({ code: 'bad-status' }, 400)
        return c.json({
          requests: await listAddressRequests(ctx, {
            project: c.req.query('project') || undefined,
            status: status as 'pending' | undefined,
          }),
        })
      }),
  )

  // Approving or turning down an address needs a fresh passkey assertion for exactly that
  // decision (decision #50, item 5): the first call answers 428 with the challenge.
  for (const action of ['approve', 'reject'] as const) {
    app.post(
      `/api/admin/addresses/:project/:name/${action}`,
      (c) =>
        adminOnly(c) ??
        guard(c, async () => {
          const b = await body(c)
          const r = await decideAddressWithStepUp(
            ctx,
            webauthn,
            c.get('user'),
            c.req.param('project') ?? '',
            c.req.param('name') ?? '',
            action,
            { note: b.note, stepUp: b.stepUp },
          )
          if (r.ok) return c.json({ request: r.request })
          if (r.stepUp) return c.json({ code: r.code, stepUp: r.stepUp }, 428)
          return c.json({ code: r.code }, 403)
        }),
    )
  }

  app.get(
    '/api/deploy/addresses',
    (c) => adminOnly(c) ?? c.json({ addresses: approvedAddresses(ctx) }),
  )

  app.get('/api/p/:project/address-requests', (c) =>
    guard(c, async () => {
      const project = c.req.param('project') ?? ''
      if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
      return c.json({ requests: await listAddressRequests(ctx, { project }) })
    }),
  )

  // ---- Site settings > Languages ------------------------------------------------------------

  app.get(
    '/api/admin/languages/:project',
    (c) =>
      adminOnly(c) ?? guard(c, () => c.json(getSiteLanguages(ctx, c.req.param('project') ?? ''))),
  )

  app.put(
    '/api/admin/languages/:project',
    (c) =>
      adminOnly(c) ??
      guard(c, async () =>
        c.json(setSiteLanguages(ctx, c.get('user'), c.req.param('project') ?? '', await body(c))),
      ),
  )

  app.get('/api/p/:project/languages', (c) =>
    guard(c, () => {
      const project = c.req.param('project') ?? ''
      if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
      return c.json(getSiteLanguages(ctx, project))
    }),
  )
}
