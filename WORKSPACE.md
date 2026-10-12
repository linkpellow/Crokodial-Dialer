# Crokodial Workspace

The existing Electron dialer is the native shell. Dialer, Settings and Personal Assistant stay mounted when the user switches workspaces, so call audio, auto-dial state, unfinished messages and in-flight assistant requests remain intact. The original installed Dialer and Quotes Compass repositories are not overwritten. This app uses a separate `Crokodial Workspace` user-data directory and bundle identifier.

## Platform integration

Set the public `VITE_API_BASE` in the existing environment configuration and build. The build writes only the API origin into the main-process configuration. IPC rejects requests to other origins and redirects; no arbitrary network proxy is exposed.

- Native sign-in uses `POST /api/auth/desktop/login` with `x-crokodial-desktop-client: crokodial-sms-desktop`, consuming the platform's `{data:{token,user}}` response. `/api/auth/me` restores the bearer session from its `{data:User}` response. The web cookie-only login route and browser sessions are not used.
- `POST /api/dialer/voice-session` supplies short-lived tenant-authorized Telnyx tokens. The device identifier follows call logging. Token renewal waits until active calls finish. SIP passwords are never compiled into the renderer.
- The assistant selects an existing `personal_assistant` from `GET /api/ai-agents`. Existing `sales` and `customer_service` modes are unchanged.
- Private conversations use `/api/ai-agents/:id/test/session` and `/test/message`, with `audience: agent`. They retain platform context throughout navigation and are disposed when cleared or the signed-in workspace unmounts. They do not send customer communications. Conversation transcripts are held in memory, not written to local storage.
- Plan names, variations and current guidance use `/api/insurance-plans` and `/api/insurance-plans/:id`. The same owner-scoped plan instructions, current announcements (including customer-effective-date scope), support contacts and document status are visible in both assistant services. `/plans` and `/ai-assistants` open the actual platform configuration pages.
- Requests carry contract version `2026-02-26.1`, matching the platform shared contract.

## Preserved Quotes Compass engine

Insurance research runs the existing Quotes Compass `runAssistantChat` orchestrator inside a private Node child process. It reuses its original quote, comparison, benefits, formulary and brochure modules/data; no HTTP server or second Electron app is started. Clicking a cited plan opens its original brochure. The child's conversation state survives navigation, and is cleared when the signed-in workspace closes. Golden Rule household quotes are refused because the source's specialized quote engine prices individuals only.

Source resolution uses `CROKODIAL_COMPASS_SOURCE` when explicitly set, then the packaged/staged snapshot, then the original `/Volumes/Lacie/Repos/quotes compass` checkout. Build the bundled snapshot with:

```sh
CROKODIAL_COMPASS_SOURCE='/Volumes/Lacie/Repos/quotes compass' npm run stage:insurance
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir
```

The staging script copies source code, insurance data and the required greeting helper. It excludes `.env`, credentials, caches, wake models and voice training corpora. Source PDFs and extracted text are retained for citations. Refresh the snapshot when authoritative plan data changes. Runtime credentials are never copied into the bundle. An explicit source override retains that source's existing private runtime configuration in the child process only.

The platform assistant remains the default for uploaded plan documents, plan operations, support drafts and shared configured tools. Local research shows shared platform guidance but does not inject uploaded documents into the original local catalog. A platform quote-source-mismatch response offers a handoff to Insurance research while preserving the draft and selected product. Source catalog rates should be checked against current carrier documentation before use.

## Verification and launch

```sh
npm run typecheck
npm run test:insurance
npm run test:native
npm start
```

`test:insurance` verifies the real staged catalog, a source premium, a source formulary comparison, brochure resolution, unknown-product handling and individual-only Golden Rule protection. `test:native` starts the actual Electron app in a disposable profile; all platform requests are isolated fixtures and no calls or external messages are sent. It checks the desktop login route/header/envelope, invalid-login errors, bearer restoration after reload, invalidated-session cleanup, call-audio element continuity, retained dial input/drafts, pending-request navigation, shared plan guidance, persistent sessions, asynchronous reset isolation, shared-plan locking across pending conversations, and a real packaged insurance-engine quote. Screenshots go to ignored `artifacts/`.

The packaged Apple Silicon app is `release/mac-arm64/Crokodial Workspace.app`. A local build can be run without replacing any installed application. Signed distribution and notarization require the organization's signing identity.

Production verification on 2026-10-12 UTC confirmed successful desktop sign-in in the packaged app through native UI inspection. The live Plans catalog loaded 17 primary groups and 106 product variants, and the selected LIFEX plan guidance loaded from the platform. The production Personal Assistant named `Crokodial Personal Assistant` was created as agent 6. These checks sent no customer calls or emails. The corrected backend also passed the exact live LIFEX instructions/announcements question, returning no saved instructions and no announcements matching the supplied context. A subsequent native fix accepts only the exact missing-session404 when clearing a conversation after a backend restart; permission failures, missing-agent errors and401 handling remain unchanged. The rebuilt package passed those regressions, and the normal profile was relaunched successfully with its production sign-in restored.

## Verification limits

Live tenant login and Plans retrieval are verified above. Telnyx calls and complete end-to-end platform AI behavior have not been verified by the native smoke suite. The original Quotes Compass wake-word, microphone calibration and voice playback shell is not embedded; the unified panel currently preserves its text-based insurance tools and source citations. Open-ended local replies require the existing Ollama runtime/models. Private in-memory conversations intentionally reset on app restart or logout. These limitations must not be reported as production parity.

## Dependency security review

The native runtime was upgraded to Electron 44.7.0 (macOS 13 or later) and packaging to electron-builder 26.15.3. Compatible patched tooling updates removed all critical audit findings. Build tooling is classified as development dependencies and excluded from the application runtime. The remaining production audit findings are three moderate transitive notices around UUID buffer APIs inside the Telnyx SDK; no high or critical production dependency findings remain. Five high development-only findings derive from Tailwind 3's braces/glob dependency, which has no compatible patched release. A Tailwind 4 migration requires a separate styling migration and visual regression pass. No forced Telnyx downgrade was applied.

A bounded cold-start check reached the installed qwen3.5:4b-q4_K_M model and returned a synthetic insurance-information answer in 98 seconds, with 96.75 seconds spent loading the model. When no explicit source/user model is configured, the native adapter prefers that installed model (then qwen2.5:7b/14b), without downloading anything. The native request allows three minutes for cold startup, and the interface explains the delay. Explicit existing model settings remain authoritative.

The native worker also passed a real synthetic conversation using automatically selected `qwen3.5:4b-q4_K_M`. Its answer acknowledged missing plan context and did not invent coverage. For this automatically chosen reasoning model only, a narrow private-process compatibility adapter sets `think: false` on local Ollama chat requests because the preserved source stream parser reads visible content, not hidden reasoning. Explicitly configured user models and unrelated requests are untouched. Set `CROKODIAL_TEST_LOCAL_MODEL=1` for the optional actual-model packaged smoke check.

The final packaged Apple Silicon binary passed the optional real-model smoke (`CROKODIAL_TEST_LOCAL_MODEL=1`) using its bundled worker and automatically selected 4b model at the preserved 8192-token context. It also passed the full isolated platform/native navigation smoke from the packaged executable, not only the development runtime. The final app was launched separately with its own persistent user profile and subsequently signed into production as verified above.
