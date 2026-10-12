# Crokodial Workspace

The existing Electron dialer is the native shell. Dialer, Contacts, Notes, Settings and Personal Assistant stay mounted when the user switches workspaces, so call audio, auto-dial state, unfinished messages and in-flight assistant requests remain intact. The original installed Dialer and Quotes Compass repositories are not overwritten. This app uses a separate `Crokodial Workspace` user-data directory and bundle identifier.

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

Notes has its own persistent tab with two separate views. Search and a compact chronological appointment list fill the panel by default. Each row shows its actual full time slot, name and status badge. Today, previous/next day, date selection, manual refresh, focus refresh and 30-second refresh use the existing `/api/appointments` data and platform visibility/follow-up helpers. Selecting a linked appointment replaces the list with a full-height contact editor; the back arrow restores the same date and list scroll position. Unlinked calendar events never create contacts. The bottom navigation uses evenly spaced icons with accessible names and keyboard navigation.

The selected appointment's disposition dropdown uses the existing catalog and canonical mutation with `source: appointments` and the exact appointment ID. A background reassociation disables stale writes. Search-only contact dispositions use the existing non-call contact path (`source: sms`) so changing a disposition cannot fabricate call metadata. Follow-up status remains separate from disposition.

Notes autosave through the existing serialized, revision-aware draft store, including blur/back navigation, without a normal Save button or status label. Failures and conflicts remain actionable, including failures that arrive after switching contacts; drafts stay available for retry. The contact footer places Record and History on the left and the shared Call/End Call control on the right, without covering note text. Recording options, AI drafts and saved audio remain available through the Record details menu. No recording starts automatically.

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

Native release `0df8621` was installed at `release/mac-arm64/Crokodial Workspace.app`; its `app.asar` SHA-256 is `c0a9d540bff316254329f0c2df1cd747b5ed1be94d5f8c9e3353e45564ef6d29`. The prior package is preserved at `release/backups/workspace-before-0df8621/Crokodial Workspace.app`. A graceful restart preserved the normal profile and restored production sign-in. Live UI inspection confirmed chronological appointments, canonical saved notes after appointment selection, separate disposition/follow-up controls, and the clean selector-free assistant. A LifeX deductible question returned the expected variation clarification against production; the disposable conversation was cleared. The app was left open on Notes. No customer notes/dispositions, calls, audio capture, customer communications or paid inference were exercised in this rollout. The platform repository contains the sanitized rollout evidence at `private-sms-app/docs/unified-desktop/workspace-appointments-assistant-production-rollout.json`.

## Approved Notes mockup — October 12, 2026

The two-view Notes layout and icon-only navigation passed `npm run typecheck`, `npm run build`, 25 native state/routing/real-engine tests, and all three Electron Notes fixtures (`native-appointments`, `native-notes`, `native-notes-shell`). Tests cover date/scroll restoration, full time slots, actual disposition values, autosave on navigation, failed background saves and recovery, delayed disposition response isolation, and preserved recording contact/session identity. Synthetic two-source MediaRecorder checks retain mute, end-call, retry and final-summary behavior. Rendered list/detail screenshots were inspected at narrow desktop size with no horizontal overflow.

The packaged app also passed `native-workspace.test.cjs` using `CROKODIAL_APP_EXECUTABLE`, including sign-in/session restoration, icon-tab navigation and mounted call-audio continuity. All four compiled main/preload/renderer asset files match the tested build. `app.asar` SHA-256: `3b5c98de4ae160bcc94343c65a0e3c0b2cb25318bc983e7b5968feb368514424`. The unchanged platform passed `npx jest --runInBand` (4,309 tests; 307 suites) and all nine `npm run gate:finalization` gates, including schema drift checks and controlled identity failures. This update requires no backend deployment or migration. Automated verification used disposable profiles, synthetic customer/audio data and isolated API responses; no customer records, real calls or paid inference were used.

Native layout release `b97cbaa` was installed and opened on October 12, 2026 with the existing sign-in restored. Live UI inspection confirmed chronological appointment ranges and badges, a separate full-height editor showing the existing contact notes and actual disposition, and Back restoring the same date/list. No customer notes, dispositions or calls were modified during this inspection. The previous app is preserved at `release/backups/workspace-before-b97cbaa/Crokodial Workspace.app`; the normal user profile was unchanged.

## Contacts and combined activity

Contacts sits beside Dialer in the five-icon navigation. It reads the signed-in user's active contacts and leads through `/api/contacts/workspace`, searches names and formatted phone numbers, and filters All, Leads and Clients using canonical client membership. Opaque keyset cursors keep older contacts available. Search, filters and list position stay mounted when opening Notes and returning. A confirmed disposition update refreshes the cached membership, including contacts beyond the first page.

Contacts and appointment selection share the same revision-aware notes editor and recording controller. History replaces only the editor area, retaining the contact header and call/recording controls. Back restores the text selection, caret and editor scroll. The owner-scoped `/api/contacts/workspace/:id/activity` feed merges canonical appointments with attributed Telnyx call records, ordered by timestamp with stable cursor tie-breaks. Provider facts take precedence over legacy call logs; legacy-only records are labeled when expanded, and CRM dispositions never replace the provider call outcome. Contact ownership is rechecked for every request; calls are never associated by a guessed name or phone match.

Call uses the existing assigned caller-ID selection and single Telnyx engine. It becomes End Call while dialing, ringing, connected or held, and shows elapsed connected time. Browsing another contact never retargets an active call; its identity remains visible. Calls started from the contact footer use the inline disposition dropdown rather than the dialer's post-call modal. Actual outbound SDK calls are registered before answer so missed attempts remain eligible for history; SDK creation failures release microphone resources and leave calling usable. Recording still requires matching phone/contact identity and never starts automatically.

History supports All, Calls and Appointments, date grouping, full appointment slots, call direction/outcome/duration, expandable evidence details, and older activity on scroll. Refresh on return, call state changes, focus and every 30 seconds while visible incorporates delayed provider updates. Overlapping refreshes preserve loaded older activity and the visible scroll anchor; a completely changed feed restarts pagination instead of implying a gap is complete. No schema migration is required for these read APIs.

### Contacts release verification — October 12, 2026

Platform release `ea45c9da` deployed successfully as Railway deployment `c2ed67a8-8eec-4284-bcc0-8d2c839f5e3e`. All eight public checks, four compiled runtime hashes, 226 migration fingerprints, and read-only schema/integrity checks passed. Bounded startup/runtime logs contained no HTTP500 or fatal events; existing provider campaign409 and usage-sync warnings matched the prior deployment. No migration was added.

Native release `4671087` passed typecheck/build, 35 state/routing/real-engine tests, all four Electron Contacts/Notes/appointment fixtures, and the actual packaged Workspace smoke. The package's four main/preload/renderer files matched the tested build. It was installed at `release/mac-arm64/Crokodial Workspace.app` with `app.asar` SHA-256 `fbf8b66a4cded8a06750195811cc4dc1817d2aaecf3841241729ced9811b66c5`; the prior package remains at `release/backups/workspace-before-4671087/Crokodial Workspace.app`. The normal profile and sign-in were preserved.

Read-only live UI inspection confirmed actual Contacts, name search, Clients filtering, shared saved notes from Contacts and appointments, actual disposition display, appointment History, the Calls filter's empty state for the inspected contact, persistent call/recording controls, return to notes, and retained contact search. The app was left on Contacts. Call/End Call state, elapsed timer, autosave, cursor/scroll restoration, combined timeline ordering, older pages and synthetic recording were verified with isolated fixtures. No customer notes/dispositions were changed, and no real calls or audio capture were started. Sanitized rollout evidence is in the platform repository at `private-sms-app/docs/unified-desktop/workspace-contacts-production-rollout.json`.
