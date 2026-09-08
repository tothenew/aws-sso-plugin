# Contributing

This extension reads AWS credentials. A change here can turn it into a
credential exfiltration channel, so the process is stricter than the size of the
codebase suggests. Read this before opening a PR.

## Layout

```
extension/           the only thing that reaches a user's browser
  manifest.json      MV3 manifest, minimal permissions
  background.js      interception, assertion parsing, STS exchange
  popup.html/css/js  credential display, countdown, copy helpers
  icons/ assets/     artwork
README.md            install and use instructions for users
CONTRIBUTING.md      this file
LICENSE
.github/             PR checks, security scanning, Dependabot
```

Users point *Load unpacked* at `extension/`, so anything outside it is free to
change without touching what people have installed. The scanning steps in CI
are scoped to `extension/` for the same reason.

## Ground rules

- **Nobody pushes to `main`.** Not maintainers, not admins. Every change is a
  pull request with review.
- **No dependencies.** No npm packages, no bundler, no vendored library, no
  script pulled from a CDN. The extension is plain JavaScript against browser
  and AWS APIs, and CI fails if that changes.
- **Permissions never widen quietly.** `extension/manifest.json` is compared
  against [.github/expected-permissions.json](.github/expected-permissions.json)
  on every PR. Widening means editing both files, in the same PR, with a reason.
- **No network destination but AWS STS.** CI extracts every `https://` literal
  in `extension/` and fails on anything unapproved.

## How to propose a change

Maintainers: branch off `main` and open a PR — no direct pushes, including your
own. Everyone else: fork, then open a PR from the fork. Write access is limited
to the two maintainers.

1. Branch off `main` (or fork, then branch).
2. Make the change. Bump `version` in `extension/manifest.json`.
3. Test it for real — load `extension/` unpacked in Chrome, sign in through
   Keycloak, confirm the credentials work with `aws sts get-caller-identity`.
   CI cannot do any of this.
4. Open a PR and fill in the template, including the security checklist.

Run the checks locally before pushing, from the repo root:

```bash
node .github/scripts/check-manifest.mjs extension
find . -name '*.js' -o -name '*.mjs' | grep -v '^./.git/' | xargs -n1 node --check
```

## What CI runs

`.github/workflows/pr-checks.yml`

| Check | What it fails on |
| --- | --- |
| Manifest and permissions | invalid JSON anywhere in the repo; `extension/manifest.json` not Manifest V3; a missing icon or script the manifest points at; any permission drift from the approved list; broad scopes like `<all_urls>` |
| JavaScript syntax | any `.js` / `.mjs` that doesn't parse |
| No third-party or remote code | committed `node_modules` or a lockfile; `importScripts`, `eval`, `new Function`, or a CDN reference in `extension/`; an `https://` literal there pointing anywhere but the approved AWS hosts |

`.github/workflows/security.yml`

| Check | What it does |
| --- | --- |
| CodeQL | scans our JavaScript with the `security-extended` query set — injection, unsafe DOM writes, prototype pollution, unsafe regex. Also runs weekly, so new queries and advisories reach unchanged code. |
| Dependency review | fails a PR that introduces a dependency with a moderate-or-worse advisory. A no-op while there are no dependencies. |

Dependabot keeps the GitHub Actions used by these workflows up to date.

**Committed secrets are not a CI check here, on purpose.** GitHub's secret
scanning with push protection catches them at push time, before they are public,
which a CI check cannot do. Enabling it is step 3 below.

---

## Repo settings a maintainer must configure

**The workflows above cannot stop a direct push — only branch protection can.**
Files in the repo are not enough. Set this up once, in the GitHub UI, or the
"nobody makes changes" guarantee does not exist.

### 1. Protect `main`

*Settings → Branches → Add branch protection rule* (or *Rules → Rulesets*),
branch name pattern `main`:

- [ ] Require a pull request before merging
  - [ ] Require approvals: **1**
  - [ ] Dismiss stale pull request approvals when new commits are pushed

  Only the two maintainers have write access, and GitHub never lets you approve
  your own PR — so *1 approval* already means "the other maintainer signed off".
  That is why there is no CODEOWNERS file here; it would add a second layer
  saying the same thing. Revisit that if the repo ever gains more collaborators
  than the people you want gating changes.

  Combined with *include administrators* below, the trade-off is real, so know
  it going in: if one of you is away, the other cannot merge anything. Live with
  it, or temporarily allow an admin bypass and say why in the PR.
- [ ] Require status checks to pass before merging → *Require branches to be up
      to date*, then add every check by name:
      `Manifest and permissions`, `JavaScript syntax`,
      `No third-party or remote code`, `CodeQL`, `Dependency review`
      *(they only become selectable after the workflows have run once — open a
      throwaway PR first, then come back)*
- [ ] Require conversation resolution before merging
- [ ] Require signed commits *(recommended — it ties each commit to a key, not
      just to a display name)*
- [ ] Do not allow bypassing the above settings — **include administrators**
- [ ] Block force pushes
- [ ] Restrict deletions

### 2. Lock down Actions

*Settings → Actions → General*:

- [ ] Allow only actions created by GitHub, plus the ones these workflows use
- [ ] Workflow permissions: **Read repository contents**
- [ ] Uncheck *Allow GitHub Actions to create and approve pull requests*
- [ ] Require approval for **all** outside collaborators' workflow runs

A pull request from a fork gets a read-only token and no secrets. That is the
behaviour you want on a public repo — it means an untrusted PR can run the
checks but cannot act on the repo.

### 3. Turn on the scanning GitHub gives you free

*Settings → Code security*:

- [ ] Secret scanning
- [ ] **Push protection** — this rejects a commit containing a live AWS key at
      push time, before it is ever public. On a repo about AWS credentials, it
      is the single highest-value switch on this page.
- [ ] Private vulnerability reporting

Leave **CodeQL default setup off** — `security.yml` in this repo is the advanced
setup, and enabling both causes duplicate, conflicting analyses.

### 4. Keep the collaborator list short

*Settings → Collaborators*: the two maintainers, with **write**. Nobody else,
and no one with admin who isn't a maintainer. The approval rule above is only as
strong as this list — every extra person with write access is another possible
approver.

### 5. Before you make the repo public

- [ ] Confirm the copyright line in [LICENSE](LICENSE) names the right legal
      entity, and that legal is happy with MIT for company-owned code going
      public. Forks persist after a repo is deleted, so this is effectively
      irreversible once published.
- [ ] Replace `<your-org>` in the README clone URL.
- [ ] Check `git log -p` for anything that shouldn't be public. History is
      published too, not just the current files.
- [ ] Confirm the repo root is this folder. Nothing from a parent directory
      should be inside it.
