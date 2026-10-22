# Microsoft 365 mail: setup for your tenant

The app sends mail through Exchange Online with SMTP AUTH and an OAuth token (client credentials, no user sign-in). Values in [square brackets] are not known yet.

## 1. App registration (Microsoft Entra admin centre)
1. Entra ID > App registrations > New registration. Name: [Site Studio mail]. Supported account types: this organisation only. No redirect URI.
2. From the overview, copy the **Directory (tenant) ID** [tenant] and the **Application (client) ID** [client-id].
3. Certificates & secrets > New client secret. Copy the **Value** at once (it is shown once). Expiry: [chosen lifetime]. Put a reminder in the calendar to renew it before it expires; mail stops silently otherwise (the mail log shows the failure).

## 2. Permission
1. API permissions > Add a permission > APIs my organisation uses > **Office 365 Exchange Online** > Application permissions > **SMTP.SendAsApp**.
2. **Grant admin consent** for [tenant name]. The status must read "Granted".

## 3. Exchange: register the service principal and give it the mailbox
Run in Exchange Online PowerShell as an Exchange admin:

```
Connect-ExchangeOnline
New-ServicePrincipal -AppId [client-id] -ServiceId [enterprise-app-object-id] -DisplayName "Site Studio mail"
Add-MailboxPermission -Identity "[mailbox]@[your-domain]" -User [enterprise-app-object-id] -AccessRights FullAccess
```

- `[enterprise-app-object-id]` is the **Object ID of the enterprise application** (Entra ID > Enterprise applications > the app), not of the app registration.
- Send As on the mailbox may be needed instead of, or as well as, FullAccess if your tenant rules require it: [check in your tenant].

## 4. SMTP AUTH on the mailbox
- The mailbox needs SMTP AUTH enabled: `Set-CASMailbox -Identity "[mailbox]@[your-domain]" -SmtpClientAuthenticationDisabled $false`.
- If the tenant has Security Defaults or a Conditional Access policy that blocks it, an exception for this service principal is needed: [your policy].
- Changes in Exchange can take [up to an hour] to apply.

## 5. In the app
Admin > Notifications and mail > How mail is sent: **Microsoft 365 (OAuth)**. Fill in the tenant ID [tenant], client ID [client-id], client secret and sender mailbox [mailbox]@[your-domain], save, then **Send test email** (it goes to your own address; set it in the table below first).

## If the test fails
- "Microsoft refused the sign-in (401, invalid_client)": wrong client secret or client ID, or the secret has expired.
- "(400, invalid_request)" or an unknown tenant: check the tenant ID.
- A sign-in that works but SMTP refuses (535 5.7.3 or similar): steps 3 and 4 are incomplete, or still propagating.
