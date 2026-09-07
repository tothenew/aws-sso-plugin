# AWS STS Keys — Setup Guide

## Before you start

- Google Chrome or Microsoft Edge, version 116 or newer
- Your normal Keycloak access to the AWS console
- Git installed on your machine

---

## Step 1 — Clone the repository

Clone the GitHub repository to a folder you will not delete or move:

```bash
git clone <REPOSITORY_URL>
```

Then open the cloned repository and locate the `kc-aws-sts` folder.

For example:

- macOS / Linux: `~/tools/aws-sso-plugin/sso/kc-aws-sts`
- Windows: `C:\Users\<you>\tools\aws-sso-plugin\sso\kc-aws-sts`

**This matters.** Chrome loads the extension directly from this folder every time
it starts. It does not copy the files. If you move or delete the repository, the
extension will no longer be available.

Make sure `manifest.json` is directly inside the `kc-aws-sts` folder. This is the
folder you will select in Step 2.

## Step 2 — Load it into Chrome

1. Open a new tab and go to `chrome://extensions`
   *(Edge: `edge://extensions`)*
2. Turn on **Developer mode** — the toggle in the top right
3. Click **Load unpacked** — button in the top left
4. Select the `kc-aws-sts` folder from Step 1 and confirm

A card titled **AWS STS Keys (Keycloak SSO)** appears. If you get an error
instead, jump to Troubleshooting below.

## Step 3 — Pin it to the toolbar

Click the puzzle-piece icon to the right of the address bar, find **AWS STS
Keys**, and click the pin next to it. The key icon now sits in your toolbar.

## Step 4 — Use it

1. Sign in to the AWS console through Keycloak, exactly as you normally do
2. A number appears on the extension icon — that's how many roles it captured
3. Click the icon

You'll see a card for each role you have, showing the account number, a countdown
to expiry, and the three credential values. The secret is hidden until you click
**Show**.

**If you were already signed in to AWS before installing:** sign out and sign in
again. The extension can only catch a sign-in that happens while it's running.

---

## Using the credentials

### macOS / Linux

Click **Copy shell exports**, paste into your terminal, press Enter:

```
export AWS_ACCESS_KEY_ID=ASIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...
```

These apply to that terminal window only. Open a new tab, and you'll need to
paste again.

### Windows

Use **Copy profile block** instead — the shell exports are Bash syntax and won't
work in PowerShell or CMD. See the next section.

### Any platform — a named profile

Click **Copy profile block** and paste it into your AWS credentials file:

- macOS / Linux: `~/.aws/credentials`
- Windows: `C:\Users\<you>\.aws\credentials`

You get a block like:

```ini
[123456789012-PlatformAdmin]
aws_access_key_id = ASIA...
aws_secret_access_key = ...
aws_session_token = ...
```

Then use it from anywhere:

```bash
aws s3 ls --profile 123456789012-PlatformAdmin
```

Replace the old block when you refresh, rather than adding a second one with the
same name.

### Check it worked

```bash
aws sts get-caller-identity
```

You should see your own email address in the returned ARN.

---

## What to expect

- **Credentials last 4 hours.** When the countdown runs out, sign in to the AWS
  console again and copy fresh ones. There is no automatic refresh — that's
  deliberate.
- **They vanish when you quit Chrome.** Nothing is written to disk by the
  extension. Reopening Chrome gives you an empty popup until you sign in again.
- **You'll see one card per role you have.** If you have three roles across two
  accounts, you get three cards.

---

## Please don't

These credentials carry exactly the AWS permissions you already have. Treat them
like a password:

- Don't paste them into `.bashrc`, `.zshrc`, or any file that gets committed
- Don't put them in a Slack message, ticket, or shared doc
- Don't paste them into any website, including SAML or JWT decoder sites
- Don't share them with a colleague — they have their own access

---
