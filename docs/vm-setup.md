# Site Studio on TAPPaaS: VMs, access and setup

What we need from the TAPPaaS cluster (`*.tappaas.qualiware.com`) to run Site Studio for real: the test install, then the same layout for production. It replaces the local stand-ins with real hosts, so spikes 2 and 4 can run properly and the "pending VM" items in M6–M8 can close.

Unknown facts are in [square brackets].

## 0. Decided (22 Oct)

| | Decision |
|---|---|
| Platform | **TAPPaaS.** Azure stays the fallback (§9). The date is open. |
| Template | **Debian**, plain systemd units. |
| Hostnames | `<vm>.tappaas.qualiware.com`, a name per VM. The **preview** is the exception: it gets **its own registered domain** ([preview-domain], e.g. `preview.[qualiware-preview.com]`), because rule 4 forbids the app and the preview sharing one domain. |
| TLS | **Caddy on TAPPaaS terminates TLS** for every name, with TAPPaaS's existing ACME through Azure DNS. That includes the public production site: decision #51 replaces #3 for TAPPaaS installs. |
| The check runner | Goes in the **existing service zone**, with a host firewall on the VM itself (§4). |
| Model endpoint | Not part of the VM setup. An Admin adds it after install under **Admin → Models** (M8); the key is sealed and never shown again. |
| Mail | Tested last; ignored for now. |
| Who does the work | You, on TAPPaaS with Claude, following the runbook in §8. I need SSH to the VMs afterwards (§7). |

## 1. The shape: three VMs

| VM | Name | Runs | Zone |
|---|---|---|---|
| **studio** | `studio.tappaas.qualiware.com` (the app) and `preview.[preview-domain]` (the preview) | The Bun app, ports 3000 (app) and 3001 (preview) | the service zone, [srv's name on your site] |
| **checks** | `checks.tappaas.qualiware.com` (internal only; no public name needed) | The check runner (`apps/worker`): Node, Playwright, Chromium, Lighthouse | the same service zone, with a host firewall |
| **prod** | `prod.tappaas.qualiware.com` (management), plus the public site names, e.g. [www.example.com] | The production agent and its web server (`apps/agent`), port 8080, plain HTTP behind Caddy | `dmz` |

### Traffic rules

| From → To | Allowed | Port | Why |
|---|---|---|---|
| Admins' devices (admin VPN / client zone) → Caddy → studio | yes | 443 → 3000 and 3001 | People use the app and the preview. |
| Internet → Caddy → prod | yes | 443 → 8080 (80 → redirect) | The public site. Caddy passes the bytes through unchanged (§5). |
| studio → prod | yes, **studio's address only** | 22 (SFTP) | The app pushes to production's inbox and reads its outbox (#1). |
| studio ↔ checks | only the NFS share (§4) | 2049 | Jobs travel through a shared folder; no other traffic between the two. |
| checks → anything else | **no** (DNS and NTP on the firewall only) | — | Generated code must not reach the app, the LAN or the internet (#40, decision #2). |
| prod → studio or the service zone | **no** | — | "Production never connects to the app" (#1, rule 5). Spike 2 tests exactly this. |
| prod → internet | **no** (DNS and NTP only) | — | Nothing needs to go out: releases arrive through the inbox. |
| studio → internet | yes, a short list | 443 | Only the model endpoint once an Admin adds one (later, mail). |
| mgmt → all | yes | 22 | TAPPaaS management and Proxmox Backup Server. |

## 2. The VMs

All three come from the TAPPaaS **Debian** template, with `dependsOn: ["cluster:vm", "backup:vm"]`, so Proxmox Backup Server snapshots them nightly (plan §12). There's no HA for the test install.

| | studio | checks | prod |
|---|---|---|---|
| vCPU | 4 | 4 | 2 |
| RAM | 8 GB | 8 GB (2–4 GB per check, two at a time; decision #2) | 4 GB |
| System disk | 40 GB | 40 GB (the browser takes 2–3 GB) | 20 GB |
| Data disk | 100 GB at `/var/lib/site-studio` (`DATA_DIR`), growable | 20 GB scratch at `/var/lib/site-studio-checks` | 20 GB at `/var/lib/site-studio-agent` (the newest 5 releases) |
| Software | Bun **1.4.3** (pinned), git, rclone, ffmpeg, exiftool | Node **24**, Bun 1.4.3 (to install), Playwright's Chromium, gitleaks, nftables | Bun **1.4.3** (pinned), OpenSSH server |
| Service user | `studio` (systemd, no login) | `checks` (systemd, no login) | `agent` (systemd, no login) and `studio-sftp` (SFTP only) |

## 3. studio: the app and the preview

- **Caddy routes:**
  - `studio.tappaas.qualiware.com` → `studio:3000`;
  - `preview.[preview-domain]` → `studio:3001`.

  Both are HTTPS from TAPPaaS's ACME through Azure DNS. The preview domain needs its DNS zone where that ACME setup can reach it ([Azure DNS zone for preview-domain]).
- **Caddy must not add or change these headers on either name:**
  - `Content-Security-Policy`, `Set-Cookie`, `X-Frame-Options`, `Referrer-Policy`;
  - and nothing else that touches framing.

  The app sets its own CSP and the preview sets the contract CSP, and the tests depend on them. Plain `reverse_proxy` does this by default; just don't add a `header` block for these names.
- **`/etc/site-studio/studio.env`** (owner `studio`, mode 0600; you write it, I never read it):
  - `APP_URL=https://studio.tappaas.qualiware.com`
  - `PREVIEW_URL=https://preview.[preview-domain]`
  - `DATA_DIR=/var/lib/site-studio`
  - `APP_SECRET=` 32+ random characters: `openssl rand -base64 48`
  - `INSTANCE_ID=tappaas-test`
  - `BACKUP_PASSPHRASE=`: a long random phrase, stored outside TAPPaaS too, for example in your password manager.
  - The LLM variables can stay empty. AI features are off until an Admin adds a model endpoint.
- **Backups:** Proxmox Backup Server nightly for the whole VM, plus the app's own encrypted backup to a folder target on the TAPPaaS NFS storage (`storage:nfs`).

## 4. checks: the check runner

- **The job folder:** a TAPPaaS NFS share `site-studio-checks`, mounted at `/var/lib/site-studio/checks` on studio and at `/var/lib/site-studio-checks/jobs` on checks. The app copies each package archive into the share before queueing a job, so checks never sees the rest of `DATA_DIR`. That's a small code change I'll make when we set up. The worker checks every archive's SHA-256 before unpacking, so a tampered share fails closed.
- **The host firewall** (nftables on the checks VM), because it shares the zone with studio:
  - **outbound:** allow DNS and NTP to the firewall and NFS (2049) to the storage host; drop everything else, including traffic to studio;
  - **inbound:** SSH from mgmt only;
  - plus one OPNsense rule: no traffic from checks to studio on any port.

  I'll give you the exact nftables file (§8, step 4).
- **The browser:** Playwright's Chromium, installed once while outbound internet is briefly open; then the rules above go on. The worker's `channel` setting switches from the local Edge to Chromium (a one-line change).
- **gitleaks** replaces the regex secret scan here.

## 5. prod: the production agent

- **Caddy → prod:8080**, for the public site names. The agent serves plain HTTP on 8080 to Caddy only, and sends the security headers itself:
  - the contract CSP, `X-Frame-Options`, HSTS and the rest;
  - Caddy must not add or change them, the same rule as §3.

  Byte-identical serving (rule 7) holds as long as Caddy does nothing but proxy. Compression is fine; any content rewrite is not.
- **The agent's own TLS stays off.** No `cert` command is ever sent on TAPPaaS, so the agent's certificate code is unused here. It remains for installs on a VPS or your own machine (decision #51).
- **The SFTP inbox and outbox** (spike 2):
  - user `studio-sftp`, key-only, `ForceCommand internal-sftp`, `ChrootDirectory /srv/studio-sftp`;
  - `inbox/`: writable and deletable by `studio-sftp` (decision #50 item 10), readable by `agent`;
  - `outbox/`: writable by `agent`, read-only for `studio-sftp`;
  - no forwarding of any kind;
  - `AllowUsers studio-sftp@<studio's address> <your admin user>`.
- **The agent:** `bun src/main.ts run /etc/site-studio/agent.json` as `agent`, under systemd with `Restart=always`. It opens no outbound connection.
- **Pairing**, from the app's Deployment tab:
  1. connect to `prod.tappaas.qualiware.com:22`, with the site's domains;
  2. compare the host key with the server's console;
  3. prepare the pairing file;
  4. confirm with a passkey;
  5. on prod, run `bun src/main.ts confirm /etc/site-studio/agent.json <fingerprint>`, comparing the fingerprint shown in the app (#25, #31).

## 6. Hostnames to create in Caddy and DNS

| Name | Points to | Public? |
|---|---|---|
| `studio.tappaas.qualiware.com` | studio:3000 | internal (admin VPN) |
| `preview.[preview-domain]` | studio:3001 | internal (admin VPN) |
| `checks.tappaas.qualiware.com` | (no route needed) | — |
| `prod.tappaas.qualiware.com` | prod:22 (SFTP, from studio only) | internal |
| [www.example.com] (the test site's public name) | Caddy → prod:8080 | **public** |

## 7. Access I need

1. **SSH, key-only,** to studio, checks and prod as a user with `sudo`. I'll generate the key on this machine and give you the public half when we start (§8, step 0).
2. Nothing else: no Proxmox, OPNsense or Authentik access, and no secrets in chat. You write `studio.env` yourself (§3).

## 8. Runbook (for you and Claude on TAPPaaS)

Each step names what to do. Your TAPPaaS Claude knows the exact `module-manager`, `network-manager` and Caddy commands for your cluster. Tell me when a step is done, and I check it from inside the VMs.

0. **Me:** generate the SSH key and send you the public half.
1. **Preview domain:** register [preview-domain], or pick one QualiWare already owns that isn't under qualiware.com. Put its DNS zone in Azure DNS so TAPPaaS's ACME can issue for it.
2. **Create three VMs** from the Debian template, with the sizes in §2: `studio` and `checks` in the service zone, `prod` in `dmz`. Add my public key to a sudo user on each, and add each VM to the nightly Proxmox Backup Server job.
3. **Storage:** create the NFS share `site-studio-checks`, mountable by studio and checks only.
4. **Network rules:** the OPNsense rules in §1:
   - studio → prod:22;
   - checks ↔ storage:2049;
   - checks → studio denied;
   - prod → anything internal denied;
   - prod → internet denied;
   - checks → internet denied.

   Leave checks' internet open for now; I close it after installing the browser. I'll send the nftables file for checks before this step.
5. **Caddy:** the names in §6, plain `reverse_proxy` with no header changes. Keep the public name for later, until prod is set up (§8, step 8).
6. **Me, on studio:**
   - install Bun 1.4.3 and the repo;
   - create the `studio` user and the systemd unit;
   - **you** write `/etc/site-studio/studio.env` (§3);
   - I run lint, the unit tests and the browser tests on Linux;
   - the spike 3 TLS run against the real names.
7. **Me, on checks:**
   - install Node, Chromium and gitleaks, and mount the share;
   - you or I then close its internet;
   - `bun run test:worker` and a real check job from the app;
   - sizing and Linux screenshot stability.
8. **Me, on prod:**
   - the `agent` and `studio-sftp` users, the chroot, the sshd settings, and the agent under systemd;
   - then pairing from the app, a signed release end to end, and the spike 2 checks: replay refused, unfreeze without a passkey refused, a failing smoke test switches back, no route to the app;
   - **you** then turn on the public name in Caddy.
9. **Backups:** one Proxmox Backup Server snapshot, the app's own backup to the NFS target, and a restore into a clean VM (M8 Done-when).
10. **Later:** the model endpoint (Admin → Models), then mail.

## 9. Azure as the fallback

Possible, but harder to control, as you expected:
- The "no route to the app" rule becomes NSG egress rules spread across subnets.
- The public site needs its own TLS setup, because Application Gateway or Front Door would replace what Caddy does here.
- Day-to-day needs Bastion or a VPN, and costs run while idle.

TAPPaaS maps one to one onto our rules, and the plan already assumes its Proxmox Backup Server.

## 10. Still open

- **[preview-domain]:** which domain, and its Azure DNS zone.
- **[srv's name on your site]:** the service zone's name.
- **[www.example.com]:** the test site's public name.
- **When.**
