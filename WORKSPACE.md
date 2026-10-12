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

The Personal Assistant uses one conversation without mode or plan selectors. Natural plan and benefit questions, plan operations, support drafts and shared tools use the platform. The platform resolves family/variation names from owner-scoped catalog metadata and retrieves each selected variation separately; ambiguous variations require clarification. Questions about premiums and cheaper alternatives use the preserved Compass rate tools with explicit applicant inputs. A bounded history of prior user questions carries plan context between these capabilities; it is retrieval context, not an action authorization or policy evidence. Source catalog rates should be checked against current carrier documentation before use.

## Workspace Notes

Notes has its own persistent tab. A compact chronological appointment list appears below contact search, defaulting to today with previous/next day, a date picker and Today controls. It uses the existing `/api/appointments` data with `includeExternal` and `includeFollowUp`, and mirrors the platform visibility/follow-up helpers exactly. Manual, focus and 30-second refreshes reflect web changes. The existing disposition catalog and mutation route retain `source: appointments` and the appointment ID, preserving canonical automations. Only matching contact record IDs open notes; unlinked calendar events never create contacts. Follow-up status remains separate from disposition.

Select an appointment or search for an existing contact, edit their canonical notes, and record a connected Workspace call. The selected contact must match the actual call number and registered call identity. Recording mixes the call's existing local and remote audio; it does not open another microphone or stop call-owned tracks. Mute and hold are respected.

Live AI drafts arrive as independently decodable audio segments are processed (normally after the first minute, plus provider processing time). Stopping or ending the call uploads remaining audio and adds one final summary to the contact's current notes. Revision checks preserve simultaneous typing and surface conflicts rather than overwriting notes. Keep recording for playback is initially selected; deleting saved audio keeps the notes.

Capture remains mounted when switching tabs. Pending uploads are retained in memory for explicit retry, and normal window close/logout is blocked while audio or note edits remain unsaved. Unsaved audio cannot survive a process crash or forced session invalidation; completed server uploads remain in recording history, and incomplete sessions are labeled for review/cancellation. Raw capture is bounded to two hours/64 MiB per session, with at most 4 MiB per clip. The server caps retained audio at 512 MiB per owner and expires unfinished sessions after 24 hours. Completed retained audio remains available until deleted. No recordings start automatically.

This feature requires platform migration `223_conversation_recording_sessions` and the matching recording-session routes, plus the existing transcription, summarization and audio-decoder configuration. The native app's microphone use description is packaged for macOS. OS microphone permission remains under the user's control.

Recording verification commands:

```sh
npm run test:recording-bridge
npm run build
node tests/native-notes.test.cjs
```

The Notes fixture uses actual Electron MediaRecorder with synthetic WebAudio streams, isolated API responses and a disposable profile. It does not capture the microphone, make calls or invoke paid providers. For server integration, run `npx tsx scripts/verify-workspace-notes-http.ts` in the platform's `private-sms-app` directory; it uses real auth/tenant middleware and audio decoding with synthetic AI responses on a disposable database.

## Verification and launch

```sh
npm run typecheck
npm run test:insurance
npm run test:native
node --test tests/appointments-state.test.cjs tests/assistant-routing.test.cjs
node tests/native-appointments.test.cjs
npm start
```

`test:insurance` verifies the real staged catalog, a source premium, a source formulary comparison, brochure resolution, unknown-product handling and individual-only Golden Rule protection. `test:native` starts the actual Electron app in a disposable profile; all platform requests are isolated fixtures and no calls or external messages are sent. It checks the desktop login route/header/envelope, invalid-login errors, bearer restoration after reload, invalidated-session cleanup, call-audio element continuity, retained dial input/drafts, pending-request navigation, automatic plan routing, persistent sessions, asynchronous reset isolation, conversation context across capabilities, and a real packaged insurance-engine quote. Screenshots go to ignored `artifacts/`.

The packaged Apple Silicon app is `release/mac-arm64/Crokodial Workspace.app`. A local build can be run without replacing any installed application. Signed distribution and notarization require the organization's signing identity.

Production verification on 2026-10-12 UTC confirmed successful desktop sign-in in the packaged app through native UI inspection. The live Plans catalog loaded 17 primary groups and 106 product variants, and the selected LIFEX plan guidance loaded from the platform. The production Personal Assistant named `Crokodial Personal Assistant` was created as agent 6. These checks sent no customer calls or emails. The corrected backend also passed the exact live LIFEX instructions/announcements question, returning no saved instructions and no announcements matching the supplied context. A subsequent native fix accepts only the exact missing-session404 when clearing a conversation after a backend restart; permission failures, missing-agent errors and401 handling remain unchanged. The rebuilt package passed those regressions, and the normal profile was relaunched successfully with its production sign-in restored.

## Verification limits

Live tenant login and Plans retrieval are verified above. Telnyx calls and complete end-to-end platform AI behavior have not been verified by the native smoke suite. The original Quotes Compass wake-word, microphone calibration and voice playback shell is not embedded; the unified panel currently preserves its text-based insurance tools and source citations. Open-ended local replies require the existing Ollama runtime/models. Private in-memory conversations intentionally reset on app restart or logout. These limitations must not be reported as production parity.

## Dependency security review

The native runtime was upgraded to Electron 44.7.0 (macOS 13 or later) and packaging to electron-builder 26.15.3. Compatible patched tooling updates removed all critical audit findings. Build tooling is classified as development dependencies and excluded from the application runtime. The remaining production audit findings are three moderate transitive notices around UUID buffer APIs inside the Telnyx SDK; no high or critical production dependency findings remain. Five high development-only findings derive from Tailwind 3's braces/glob dependency, which has no compatible patched release. A Tailwind 4 migration requires a separate styling migration and visual regression pass. No forced Telnyx downgrade was applied.

A bounded cold-start check reached the installed qwen3.5:4b-q4_K_M model and returned a synthetic insurance-information answer in 98 seconds, with 96.75 seconds spent loading the model. When no explicit source/user model is configured, the native adapter prefers that installed model (then qwen2.5:7b/14b), without downloading anything. The native request allows three minutes for cold startup, and the interface explains the delay. Explicit existing model settings remain authoritative.

The native worker also passed a real synthetic conversation using automatically selected `qwen3.5:4b-q4_K_M`. Its answer acknowledged missing plan context and did not invent coverage. For this automatically chosen reasoning model only, a narrow private-process compatibility adapter sets `think: false` on local Ollama chat requests because the preserved source stream parser reads visible content, not hidden reasoning. Explicitly configured user models and unrelated requests are untouched. Set `CROKODIAL_TEST_LOCAL_MODEL=1` for the optional actual-model packaged smoke check.

The final packaged Apple Silicon binary passed the optional real-model smoke (`CROKODIAL_TEST_LOCAL_MODEL=1`) using its bundled worker and automatically selected 4b model at the preserved 8192-token context. It also passed the full isolated platform/native navigation smoke from the packaged executable, not only the development runtime. The final app was launched separately with its own persistent user profile and subsequently signed into production as verified above.

## Appointments and automatic routing build — October 12, 2026

Native commits `1d61d4a` and `738130b` add compact appointments and the unified conversation. Compatible platform commit: `4d439f29`. The new build passed 22 native state/routing/real-engine tests and packaged Workspace, appointment and Notes shell fixtures. The synthetic recording regression also confirms appointment selection cannot retarget an active recording. Platform verification passed 4,309 core tests,638 web UI tests and all nine schema/startup gates.

After owner approval, platform release `8bc6d99d` was deployed successfully as Railway deployment `be586361-39a3-4e40-aca1-a903292f52fc` on October 12, 2026. All 20 public checks, seven compiled runtime hashes, 226 migration fingerprints, read-only schema/integrity checks and five deterministic routing checks passed. No migration was added.

Native release `0df8621` is installed at `release/mac-arm64/Crokodial Workspace.app`; its `app.asar` SHA-256 is `c0a9d540bff316254329f0c2df1cd747b5ed1be94d5f8c9e3353e45564ef6d29`. The prior package is preserved at `release/backups/workspace-before-0df8621/Crokodial Workspace.app`. A graceful restart preserved the normal profile and restored production sign-in. Live UI inspection confirmed chronological appointments, canonical saved notes after appointment selection, separate disposition/follow-up controls, and the clean selector-free assistant. A LifeX deductible question returned the expected variation clarification against production; the disposable conversation was cleared. The app was left open on Notes. No customer notes/dispositions, calls, audio capture, customer communications or paid inference were exercised in this rollout. The platform repository contains the sanitized rollout evidence at `private-sms-app/docs/unified-desktop/workspace-appointments-assistant-production-rollout.json`.
