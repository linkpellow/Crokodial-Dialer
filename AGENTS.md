# Crokodial Workspace — native application

This repository is the user's **Dialer / Personal Assistant**: package `crokodial-dialer`, product **Crokodial Workspace**, bundle ID `com.crokodial.workspace`. The Personal Assistant is `src/renderer/components/PersonalAssistant.tsx`. This remains the correct source even though the local folder is named `crokodialer standalone copy`.

The sibling `../CrokodialSMS-1/private-sms-app` supplies shared APIs and a separate web client. Backend or web UI tests alone never prove native functionality. Reuse existing owner/tenant/auth, email approvals, CRM, scheduler and artifact services; do not rebuild parallel storage or authorization.

The former `apps/crokodial-sms-desktop` application was explicitly retired. Never restore it or use it as a substitute. The legacy `crokodial-sms-desktop` authentication header value is still a shared wire contract; preserve it until a coordinated migration is requested.

Read `WORKSPACE.md` and inspect both working trees before edits. Preserve unrelated work and the `Crokodial Workspace` user profile. Test with disposable profiles and controlled providers unless live actions are explicitly authorized. An email submission receipt is not delivery confirmation.

Build with `npm run build`. Package to a temporary output directory first, then run `node scripts/workspace-build-identity.mjs --verify-bundle '<exact bundle>'`. Use the sibling platform's `scripts/workspace-app.mjs --check` / `--open` for the canonical application. Do not guess by app name, launch a generic Electron window, or execute old Desktop shortcuts. Source/archive parity, native workflow tests, backend release verification and actual process restart are distinct evidence.

Before committing core changes, run native typechecks/build, relevant native tests, the supporting platform Core suite and schema/finalization gates. Follow the task's atomic Conventional Commit policy. Never commit credentials or `.env*`.
