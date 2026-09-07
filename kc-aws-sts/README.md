# AWS STS Keys (Keycloak SSO)

A Chrome extension for orgs that federate into AWS through Keycloak and have no
IAM users. Users sign in to the AWS console the way they already do; the
extension hands them the access key, secret key, and session token behind that
sign-in.

There is nothing to run, nothing to install locally, and no background refresh.

```
sign in to AWS console  →  click the toolbar icon  →  copy  →  done
```

## How it works

1. Keycloak POSTs a `SAMLResponse` to `https://signin.aws.amazon.com/saml`.
2. The service worker observes that POST (read-only, non-blocking) and pulls the
   `https://aws.amazon.com/SAML/Attributes/Role` values out of the assertion.
3. It calls `sts:AssumeRoleWithSAML` once per role and stores the results in
   `chrome.storage.session`.
4. The popup displays them with a countdown to expiry.

`AssumeRoleWithSAML` accepts unsigned requests, so the extension contains no
credentials, no SigV4 implementation, and no bundled AWS SDK. Every mint appears
in CloudTrail as `AssumeRoleWithSAML` attributed to the real user.

**Why all roles in the assertion, not just the one the user picked:** the
assertion is POSTed *before* the AWS role chooser appears, and it typically
expires about five minutes after issue. The exchange has to happen at sign-in
time, so at that moment there is no "chosen role" yet. Lower `MAX_ROLES` in
`background.js` if you want a tighter cap than 8.

## Session duration

A federated session lasts one hour by default. Two settings govern it, and they
must agree:

| Setting | Where | Role |
| --- | --- | --- |
| `SessionDuration` SAML attribute | Keycloak SAML client | what the assertion *requests* |
| `MaxSessionDuration` | each IAM role, each account | the ceiling STS *enforces* |

STS uses the lower of the two. If the request exceeds the ceiling, STS does not
clamp it — it rejects the exchange with
`ValidationError: The requested DurationSeconds exceeds the MaxSessionDuration
set for this role`.

**Current configuration: 3600 (1 hour).** 3600 is the AWS floor for
`MaxSessionDuration` (valid range 3600–43200), so a request for 3600 can never
exceed any role's ceiling in any account. No IAM changes are required and the
`ValidationError` above is structurally impossible.

The Keycloak mapper is optional at 3600 — omitting it produces the same result,
because `background.js` only sends `DurationSeconds` when the assertion carries
the attribute. Keeping it set to 3600 documents the intent and gives you one
value to edit later.

Mapper location: AWS SAML client → *Client scopes* → `<client-id>-dedicated` →
*Add mapper* → *By configuration* → *Hardcoded attribute*.

| Field | Value |
| --- | --- |
| Name | `aws-session-duration` |
| Friendly Name | *(blank)* |
| Attribute name | `https://aws.amazon.com/SAML/Attributes/SessionDuration` |
| Attribute NameFormat | `URI Reference` |
| Attribute value | `3600` |

### Raising it later

To go beyond an hour, **raise every federated role's ceiling first, in every
account, then raise the mapper.** Ceilings are inert on their own — nothing
requests the longer duration until the mapper asks for it — so that order has no
window where the two disagree. The reverse order breaks credential issuance for
every role you haven't updated yet.

```bash
aws iam update-role --role-name PlatformAdmin --max-session-duration 14400
```

```hcl
max_session_duration = 14400  # 4 hours; 43200 (12h) is the AWS ceiling
```

Audit an account for roles still at the default:

```bash
aws iam list-roles \
  --query 'Roles[?MaxSessionDuration==`3600`].[RoleName,MaxSessionDuration]' \
  --output table
```

Note that raising `SessionDuration` also extends the AWS console session to the
same length.

## Install

**Testing:** `chrome://extensions` → Developer mode → *Load unpacked* → this
directory.

**Rollout — do not use the Chrome Web Store copies of this pattern.** Several
exist and some request access to all sites. Host your own build and force-install
it by ID so users can't be phished onto a lookalike:

```json
{
  "ExtensionSettings": {
    "<your-extension-id>": {
      "installation_mode": "force_installed",
      "update_url": "https://tools.internal.example.com/chrome/updates.xml",
      "toolbar_pin": "force_pinned"
    },
    "ekniobabpcnfjgfbphhcolcinmnbehde": { "installation_mode": "blocked" },
    "*": { "installation_mode": "allowed" }
  }
}
```

Sign the CRX with a key you keep in your own KMS, and review any diff before
shipping a new version. This extension can read AWS credentials; treat its
release process like you'd treat a privileged IAM policy change.

## Security posture

| | |
| --- | --- |
| Host permissions | `signin.aws.amazon.com/saml` and `sts.amazonaws.com` only. No `<all_urls>`. |
| Storage | `chrome.storage.session` — memory only, gone when Chrome closes. Nothing written to disk. |
| Network | Talks to AWS STS and nothing else. No telemetry, no remote code, no CDN. |
| Secret display | Masked until the user clicks *Show*. |
| Blast radius | Credentials carry exactly the permissions the user already has in the console. No privilege gain. |

Real residual risks, stated plainly:

- Anyone who can read the user's Chrome process memory can read live credentials.
- Copied credentials land in the clipboard, and clipboard managers persist.
- If a user pastes them into a shell profile or commits them, they're valid until
  expiry. Longer sessions mean a longer window — 8 hours is a deliberate
  usability/exposure trade, so pick the number consciously.
- A malicious update to this extension would be a credential exfiltration
  channel. Hence the pinning and signing above.

## Limitations

- Chrome/Chromium only, and only for humans at a browser. CI, servers, and
  headless work need OIDC roles or instance profiles instead.
- No auto-refresh by design. When the countdown runs out, sign in again.
- Global STS endpoint (`sts.amazonaws.com`). For GovCloud or China, change
  `STS_ENDPOINT` and `host_permissions`.
- Only sees assertions posted while the extension is enabled. It cannot recover
  credentials from a console session that started earlier.

## Files

```
manifest.json    MV3 manifest, minimal permissions
background.js    interception, assertion parsing, STS exchange
popup.html/css/js  credential display, countdown, copy helpers
icons/           generated
```
