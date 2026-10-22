# Site Studio on TAPPaaS: VMs, access and setup

What we need from the TAPPaaS cluster to run Site Studio for real: the test install, then the same layout for production. It turns the local stand-ins (the local SFTP server, test CA, SMTP sink and mock model) into real hosts. That lets us run spikes 2 and 4 properly and close the "pending VM" items in M6–M8.

Unknown facts are in [square brackets]. Fill them in, or tell me and I will.

## 1. The shape: three VMs, three zones

| VM | Runs | TAPPaaS zone | Why it is separate |
|---|---|---|---|
| **studio** | The app (`studio.internal`) and the preview site (`preview.internal`), Bun | `srv` (the service zone, renamed to the site's environment at `init`) | The app holds the keys, the database and the content. It is internal only. |
| **checks** | The check runner (`apps/worker`): Node, Playwright, a browser, Lighthouse | its own zone, `checks` (new, Service type) | It opens generated, untrusted sites in a browser. It must not be able to reach the app or the internet (decision #2, plan §8.1). |
| **prod** | The production agent and web server (`apps/agent`) | `dmz` | It is the only thing on the internet. It never connects to the app (rule 5, decision #1). |

This keeps CLAUDE.md's two-site rule (`studio.internal` and `preview.internal` are different sites, not subdomains of one), and puts each trust level in its own zone.

### Zone rules (OPNsense, via `network-manager`)

| From → To | Allowed | Port | Why |
|---|---|---|---|
| your admins' devices (`work` / admin VPN) → studio | yes | 443 | People use the app and the preview. |
| studio → prod | yes, **studio's address only** | 22 (SFTP) | The app pushes to production's inbox and reads its outbox (#1). |
| studio → checks | no direct traffic | — | Jobs travel over a shared folder (see §4). |
| studio → internet | yes, to a short list | 443 (and 587 for mail) | The model endpoint, ACME + the DNS API, Microsoft 365 / SMTP. |
| checks → anything | **no** (only DNS/NTP on the firewall) | — | Generated code must not reach the app, the LAN or the internet (#40). |
| prod → studio, srv, checks | **no** | — | "Production never connects to the app" (#1, rule 5). |
| prod → internet | no (only DNS/NTP on the firewall) | — | Certificates arrive through the inbox (#3); nothing needs to go out. |
| internet → prod | yes, via a **pinhole** | 443, 80 (redirect only) | The public site. See §5 on why this is a TCP pinhole, not a TLS-terminating proxy. |
| mgmt → all | yes | 22 | TAPPaaS management, Proxmox Backup Server, the people running the cluster. |

The "no route to the app" rule is what spike 2 proves on real hardware. The rules above are its test case.

## 2. The VMs

All three use the TAPPaaS **NixOS** template (or **Debian** if you'd rather; tell me which). They declare `dependsOn: ["cluster:vm", "backup:vm"]`, so Proxmox Backup Server snapshots them nightly (plan §12). None needs HA for the test install.

| | studio | checks | prod |
|---|---|---|---|
| vCPU | 4 | 4 | 2 |
| RAM | 8 GB | 8 GB (2–4 GB per concurrent check, concurrency 2; decision #2) | 4 GB |
| Disk (system) | 40 GB | 40 GB (browsers take 2–3 GB) | 20 GB |
| Disk (data) | 100 GB for `DATA_DIR` (revisions, blobs, the release log), on ZFS, growable (`diskAutoGrow`) | 20 GB scratch for unpacked packages and screenshots | 20 GB for releases (the newest 5 kept) |
| Software | Bun **1.4.x** (pinned), git, rclone, ffmpeg, exiftool | Node **24**, playwright-core, a Chromium-family browser (see §4), gitleaks | Bun **1.4.x** (pinned), OpenSSH server |
| Service user | `studio` (no shell login; systemd unit) | `checks` (no login; systemd unit) | `agent` (runs the agent) and `studio-sftp` (SFTP only, see §5) |
| Public DNS | none | none | the site's hostnames, e.g. `[www.example.com]` |
| Internal DNS | `studio.[env].internal`, `preview.[env].internal` | `checks.[env].internal` | `prod.dmz.internal` (for the pinhole and SSH from studio) |

The internal names follow TAPPaaS's `<zone>.internal` pattern. The exact names are yours to pick; the app only needs `APP_URL` and `PREVIEW_URL` to be two different sites.

## 3. studio: the app and the preview

- **Two hostnames on one VM**, both HTTPS, served by the Bun process on two ports behind Caddy (the TAPPaaS way to publish internal names):
  - `studio.[env].internal` → `localhost:3000` (`APP_URL`);
  - `preview.[env].internal` → `localhost:3001` (`PREVIEW_URL`).
  - The certificates come from the TAPPaaS internal CA or Caddy's internal issuer, trusted by your admins' devices. Passkeys need a secure origin, so plain HTTP won't do outside localhost.
  - This also gives spike 3 its "TLS run with real hostnames", still open.
- **Environment** (`.env`, owned by `studio`, mode 0600; I never read it):
  - `APP_URL`, `PREVIEW_URL`, `DATA_DIR`, `APP_SECRET` (32+ random characters), `INSTANCE_ID`;
  - `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_CAPABILITY`: [the model endpoint you choose];
  - `BACKUP_PASSPHRASE`: for scheduled backups (decision #50); store it outside the VM's backups too.
- **Outbound allow-list:**
  - the model endpoint's host;
  - `acme-staging-v02.api.letsencrypt.org` (then `acme-v02.api.letsencrypt.org`);
  - the DNS provider's API ([which provider?]);
  - `login.microsoftonline.com` and `smtp.office365.com:587` for Microsoft 365, or your SMTP relay;
  - the rclone target, if not on the LAN.
- **Backups:** Proxmox Backup Server for the whole VM nightly (§12), plus the app's own encrypted backup to a folder target on the TAPPaaS NFS share (`storage:nfs`), and later rclone to off-site.

## 4. checks: the check runner

- **The job folder.** The app and the worker share `DATA_DIR/checks/` (pending, running, results; `docs/m6-interfaces.md`). On one machine that is a local folder. On two VMs, use a **TAPPaaS NFS share** (`storage:nfs`) for exactly that folder, mounted:
  - read-write on studio;
  - read-write on checks, but the worker only ever reads `pending/` and the archive it names, and writes `running/` and `results/`.

  The worker checks every archive's SHA-256 before unpacking (M6), so a tampered share fails closed. Alternative, if you'd rather not share a folder: the worker pulls jobs over SFTP from studio. That's a small change; tell me if you prefer it.
- **The archives** live in studio's blob store. The job names an absolute path, so either mount the blob store read-only on checks too, or have the app copy each archive into `checks/archives/` before queueing. I'd do the copy, since it keeps checks away from the rest of `DATA_DIR`.
- **The browser on Linux.** Locally the worker uses the installed Edge. On the VM use **Chromium** through Playwright's bundled browser, or Microsoft Edge for Linux if you want the same engine as local. This is one setting in `apps/worker` (`channel`). The browser download happens once at install time, with the internet opened briefly for that step only, or from a local mirror.
- **gitleaks** replaces the regex secret scan on the VM; it's a single binary.
- **No egress** apart from DNS and NTP on the firewall. That's also what makes the CSP and LAN-reach checks meaningful: a package that tries to call out fails for real.

## 5. prod: the production agent

- **TLS stays on prod.** Decision #3 says production makes its own private key and only a certificate travels in. So the public site must be a **TCP pinhole (port-forward) from the WAN to prod:443** on OPNsense, not a TLS-terminating Caddy in front. Port 80 can be forwarded too, for an HTTP→HTTPS redirect only.
- **The SFTP inbox and outbox** (spike 2):
  - a user `studio-sftp`, key-only, with password login off;
  - `ForceCommand internal-sftp`, `ChrootDirectory /srv/studio-sftp`;
  - in the chroot, `inbox/` is writable by `studio-sftp` and readable by `agent`, and the app may delete only there (decision #50, item 10); `outbox/` is writable by `agent` and read-only for `studio-sftp`;
  - no TCP forwarding, no X11, no agent forwarding, and `AllowUsers studio-sftp@<studio's address> <your admin user>`.
- **The agent:** `bun src/main.ts run /etc/site-studio/agent.json` as `agent`, under systemd, with `Restart=always`.
  - Its home is `/var/lib/site-studio-agent`: state, releases and the TLS key (0600).
  - It only reads the inbox and writes the outbox, and it opens no outbound connection.
  - The first start writes the CSR for `[www.example.com]` into the outbox.
- **Pairing**, once the VMs are up, from the app's Deployment tab:
  1. the Admin starts pairing with prod's address and the site's domains;
  2. the app shows prod's host key, and someone on the console compares it;
  3. the app writes the pairing file;
  4. on prod, `bun src/main.ts confirm /etc/site-studio/agent.json <fingerprint>`, comparing the fingerprint shown in the app (decisions #25, #31).
- **gVisor** (plan §13.5: "worth trying there") is optional for the first run.

## 6. Access I need

To set up and test without a person standing by for each step:

1. **SSH, key-only,** to studio, checks and prod as an admin user with `sudo`. My public key is [to be generated on this machine and sent to you; I'll show it]. Over the TAPPaaS admin VPN, or from a jump host in `mgmt`.
2. **The VMs created**, or a Proxmox API token limited to creating and configuring these three VMs in one pool. I'd rather you create them from the TAPPaaS templates with the sizes above; then I only need SSH.
3. **The zone and firewall rules in §1**, set by whoever runs `network-manager`. I don't need OPNsense access; I'll test the rules from inside the VMs and report what passes and fails.
4. **One NFS share** for `checks/` (§4).
5. **A domain for the test site** ([test.example.com]) and **a DNS API token** limited to that zone, for ACME DNS-01 (spike 4). Let's Encrypt staging first.
6. **The model endpoint** for real AI calls: [Azure OpenAI or another OpenAI-compatible endpoint, model name, key]. You put the key into studio's `.env` yourself.
7. **Mail:** the Microsoft 365 app registration (`docs/pending/m365-setup.md`), or an SMTP relay and an account.
8. **Proxmox Backup Server** jobs for the three VMs (`backup:vm`), and a restore test once (M8 Done-when: a restore into a clean environment gives an identical project).

What I will not need: root on Proxmox, OPNsense admin, Authentik admin, or any production secret in chat. Keys go straight into the VMs' `.env` files by you, and I never read `.env`.

## 7. Order of work once access exists

1. **studio:** install Bun, deploy the repo, set `.env`, run `bun run lint`, `bun test` and the browser tests on Linux. Also confirm whether the Bun 1.4.3 segfault in the SFTP tests appears on Linux too.
2. **The spike 3 TLS run:** the attack tests against `studio.[env].internal` and `preview.[env].internal` with real certificates.
3. **checks:** install Node and the browser, mount the share, run `bun run test:worker`, then a real job from the app. Then sizing (decision #2) and Linux screenshot stability (spike 5's pending items).
4. **prod, spike 2 for real:**
   - the chrooted SFTP user;
   - the agent under systemd;
   - pairing;
   - a signed release end to end;
   - a replayed and an expired command refused;
   - an unfreeze without a passkey refused;
   - a failing smoke test switching back;
   - "no route to the app" tested from prod.
5. **Spike 4 for real:**
   - the CSR from the outbox;
   - ACME DNS-01 against Let's Encrypt staging;
   - the certificate through the inbox, installed;
   - renewal at day 60 simulated;
   - the private key never leaves prod (checked in the release log, the backups and gitleaks).
6. **Backups:** a Proxmox Backup Server snapshot, the app's own backup to the NFS target, and a restore into a clean VM.

Each step ends with the matching spike or milestone "Pending" lines ticked or reported.

## 8. Azure as the alternative

It works, and I'd keep it as the fallback. Your instinct that it's harder to control is right, for three reasons:

- **The "no route to the app" rule** becomes Network Security Group egress rules on two subnets, plus no public IP on studio. It's doable, but it lives in Azure's portal or Terraform instead of one zone file, and is easier to get subtly wrong.
- **TLS on prod** needs a public IP on prod with an NSG allowing 443. Azure's Application Gateway and Front Door terminate TLS themselves, which conflicts with decision #3, so they can't be used.
- **Day-to-day:** Bastion or a VPN for SSH, Azure Backup in place of Proxmox Backup Server, and costs that run whether you test or not.

Two things would be simpler on Azure: the model endpoint (Azure OpenAI in the same tenant) and Microsoft 365 mail. A mix also works: the VMs on TAPPaaS, and only the model endpoint in Azure.

**Recommendation: TAPPaaS.** It's what the plan assumes (§12, §13.5, §13.6). The zones and pinholes map one to one onto our rules, and Proxmox Backup Server is already there.

## 9. Open points for you

- **Template:** NixOS or Debian? On NixOS I'd write each VM as a TAPPaaS module: `dependsOn` plus a NixOS config. On Debian, plain systemd units.
- **The environment and zone names:** the `srv` name your site uses, and whether a new `checks` zone is fine.
- **The test domain and DNS provider** for ACME.
- **The model endpoint** for the test install.
- **Mail:** Microsoft 365 or SMTP relay.
- **Who creates the VMs and the firewall rules,** and when.
