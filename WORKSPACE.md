# Crokodial Workspace

The existing Electron dialer is the native shell. Dialer, Contacts, Notes, Settings and Personal Assistant stay mounted when the user switches workspaces, so call audio, auto-dial state, unfinished messages and in-flight assistant requests remain intact. The original installed Dialer and Quotes Compass repositories are not overwritten. This app uses a separate `Crokodial Workspace` user-data directory and bundle identifier.

## Platform integration

Set the public `VITE_API_BASE` in the existing environment configuration and build. The build writes only the API origin into the main-process configuration. IPC rejects requests to other origins and redirects; no arbitrary network proxy is exposed.

- Native sign-in uses `POST /api/auth/desktop/login` with `x-crokodial-desktop-client: crokodial-sms-desktop`, consuming the platform's `{data:{token,user}}` response. `/api/auth/me` restores the bearer session from its `{data:User}` response. The web cookie-only login route and browser sessions are not used.
- `POST /api/dialer/voice-session` supplies short-lived tenant-authorized Telnyx tokens. The device identifier follows call logging. Token renewal waits until active calls finish. SIP passwords are never compiled into the renderer.
- The assistant selects an existing `personal_assistant` from `GET /api/ai-agents`. Existing `sales` and `customer_service` modes are unchanged.
- The assistant first reads `/api/ai-agents/:id/intelligence/status`, then opens `/conversation/session` with an empty request body. The server selects the one canonical owner-, tenant- and environment-scoped main conversation; the renderer cannot choose, create, reset or delete a chat. Navigation, app restart and Personal Assistant replacement reopen that same server-owned ledger. A missing owner-conversation capability fails closed and never falls back to `/test/session`. The complete transcript remains server-side and is read through bounded cursor pages. Separately, an owner-, tenant-, environment- and agent-scoped local retry journal retains only request UUID, message hash, the server-returned conversation identity and creation time, never message text. Unresolved request identities survive restart without automatic resend; an explicit retry of the same message in the same main conversation reuses its identity. Obsolete client-generated keys are read once only to migrate retry receipts, then removed; they are never sent to the server or used to select a conversation. Conversation history alone never authorizes customer communications.
- Plan names, variations and current guidance use `/api/insurance-plans` and `/api/insurance-plans/:id`. The same owner-scoped plan instructions, current announcements (including customer-effective-date scope), support contacts and document status are visible in both assistant services. `/plans` and `/ai-assistants` open the actual platform configuration pages.
- Requests carry contract version `2026-02-26.1`, matching the platform shared contract.

## Preserved Quotes Compass engine

The existing Quotes Compass `runAssistantChat` orchestrator remains available inside a private Node child process for isolated insurance qualification and regression checks. The Personal Assistant main chat routes questions, quote requests and action intent through the platform so they remain in the canonical conversation. The preserved worker reuses its original quote, comparison, benefits, formulary and brochure modules/data; no HTTP server or second Electron app is started. Golden Rule household quotes are refused because the source's specialized quote engine prices individuals only.

Source resolution uses `CROKODIAL_COMPASS_SOURCE` when explicitly set, then the packaged/staged snapshot, then the original `/Volumes/Lacie/Repos/quotes compass` checkout. Build the bundled snapshot with:

```sh
CROKODIAL_COMPASS_SOURCE='/Volumes/Lacie/Repos/quotes compass' npm run stage:insurance
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir
```

The staging script copies source code, insurance data and the required greeting helper. It excludes `.env`, credentials, caches, wake models and voice training corpora. Source PDFs and extracted text are retained for citations. Refresh the snapshot when authoritative plan data changes. Runtime credentials are never copied into the bundle. An explicit source override retains that source's existing private runtime configuration in the child process only.

The Personal Assistant uses one conversation without mode or plan selectors. Authenticated owner sessions send plan and benefit questions, premiums and cheaper-alternative requests, support drafts and action intent to the platform, which resolves saved context and permissions before responding. The platform resolves family/variation names from owner-scoped catalog metadata and retrieves each selected variation separately; ambiguous variations require clarification. A bounded set of prior user questions accompanies each request as supplemental retrieval context, while the full durable transcript remains in the canonical server ledger. Neither source authorizes an action or substitutes for policy evidence. Source catalog rates should be checked against current carrier documentation before use.

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

### Context, goals and reconnection

The assistant keeps the original conversation interface. Relationship memory and bounded goals run behind ordinary messages, with server-owned permissions and evidence. There are no additional context panels, environment banners, memory controls, chat selectors or goal setup steps. The canonical main conversation is independent of optional relationship-memory policy: transcript continuity never creates a second chat. Unknown action outcomes are not retried automatically. The matching owner/intelligence routes and main-conversation migrations are required; an older deployment without them is reported as unavailable instead of opening a private preview session.

Boot session checks retry transient connection/408/429/5xx failures at 1, 3 and 10 seconds; online/focus or Retry connection can resume after that bounded budget. Invalid sessions return to sign-in, canceled checks cannot clear a replacement sign-in, and mutations are never retried by this mechanism.

```sh
node --test tests/session-recovery.test.cjs tests/assistant-session-api.test.cjs
npm run test:native
```

The native fixture verifies recovery from transport and 503 failures and canonical main-conversation continuity across navigation, reload and execution-session replacement using synthetic data and isolated responses. It also verifies that the renderer sends no client conversation key and exposes no new-chat, reset or delete path. The Personal Assistant keeps its original native shell and adds inline workflow cards and editors. It does not claim a live provider or production deployment was tested.

```sh
npm run typecheck
npm run test:insurance
npm run test:native
node --test tests/appointments-state.test.cjs tests/assistant-routing.test.cjs
node tests/native-appointments.test.cjs
npm start
```

`test:insurance` verifies the real staged catalog, a source premium, a source formulary comparison, brochure resolution, unknown-product handling and individual-only Golden Rule protection. `test:native` starts the actual Electron app in a disposable profile; all platform requests are isolated fixtures and no calls or external messages are sent. It checks the desktop login route/header/envelope, invalid-login errors, bounded auth recovery, bearer restoration after reload, invalidated-session cleanup, call-audio element continuity, retained dial input/drafts, pending-request navigation, server-owned quote/context/action routing, canonical conversation restoration, paginated full history, fail-closed capability discovery and user-only plan history. Its owner-route replies are isolated fixtures; real insurance-engine quotes are checked separately by `test:insurance` and the application sandbox. Screenshots go to ignored `artifacts/`.

The packaged Apple Silicon app is `release/mac-arm64/Crokodial Workspace.app`. A local build can be run without replacing any installed application. Signed distribution and notarization require the organization's signing identity.

Production verification on 2026-10-12 UTC confirmed successful desktop sign-in in the packaged app through native UI inspection. The live Plans catalog loaded 17 primary groups and 106 product variants, and the selected LIFEX plan guidance loaded from the platform. The production Personal Assistant named `Crokodial Personal Assistant` was created as agent 6. These checks sent no customer calls or emails. The corrected backend also passed the exact live LIFEX instructions/announcements question, returning no saved instructions and no announcements matching the supplied context. A subsequent native fix accepts only the exact missing-session404 when clearing a conversation after a backend restart; permission failures, missing-agent errors and401 handling remain unchanged. The rebuilt package passed those regressions, and the normal profile was relaunched successfully with its production sign-in restored.

## Verification limits

Live tenant login and Plans retrieval are verified above. Telnyx calls and complete end-to-end platform AI behavior have not been verified by the native smoke suite. The original Quotes Compass wake-word, microphone calibration and voice playback shell is not embedded; the unified panel currently preserves its text-based insurance tools and source citations. Open-ended local replies require the existing Ollama runtime/models. Local insurance-engine context remains process-local. Server-backed owner conversations use the scoped restoration and memory-mode boundaries described above. These limitations must not be reported as production parity.

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

Contacts sits beside Dialer in the five-icon navigation. It reads the signed-in user's active contacts and leads through `/api/contacts/workspace`, searches names and formatted phone numbers, and uses a compact All / Clients segmented toggle with canonical client membership. All includes both leads and clients. Search starts hidden behind the magnifier and expands with a short transition. Opaque keyset cursors keep older contacts available. Search, filters and list position stay mounted when opening Notes and returning. A confirmed disposition update refreshes the cached membership, including contacts beyond the first page.

Contacts and appointment selection share the same revision-aware notes editor and recording controller. History replaces only the editor area, retaining the contact header and call/recording controls. Back restores the text selection, caret and editor scroll. The owner-scoped `/api/contacts/workspace/:id/activity` feed merges canonical appointments with attributed Telnyx call records, ordered by timestamp with stable cursor tie-breaks. Provider facts take precedence over legacy call logs; legacy-only records are labeled when expanded, and CRM dispositions never replace the provider call outcome. Contact ownership is rechecked for every request; calls are never associated by a guessed name or phone match.

Call uses the existing assigned caller-ID selection and single Telnyx engine. It becomes End Call while dialing, ringing, connected or held, and shows elapsed connected time. Browsing another contact never retargets an active call; its identity remains visible. Calls started from the contact footer use the inline disposition dropdown rather than the dialer's post-call modal. Actual outbound SDK calls are registered before answer so missed attempts remain eligible for history; SDK creation failures release microphone resources and leave calling usable. Recording still requires matching phone/contact identity and never starts automatically.

History supports All, Calls and Appointments, date grouping, full appointment slots, call direction/outcome/duration, expandable evidence details, and older activity on scroll. Refresh on return, call state changes, focus and every 30 seconds while visible incorporates delayed provider updates. Overlapping refreshes preserve loaded older activity and the visible scroll anchor; a completely changed feed restarts pagination instead of implying a gap is complete. No schema migration is required for these read APIs.

### Contacts release verification — October 12, 2026

Platform release `ea45c9da` deployed successfully as Railway deployment `c2ed67a8-8eec-4284-bcc0-8d2c839f5e3e`. All eight public checks, four compiled runtime hashes, 226 migration fingerprints, and read-only schema/integrity checks passed. Bounded startup/runtime logs contained no HTTP500 or fatal events; existing provider campaign409 and usage-sync warnings matched the prior deployment. No migration was added.

Native release `4671087` passed typecheck/build, 35 state/routing/real-engine tests, all four Electron Contacts/Notes/appointment fixtures, and the actual packaged Workspace smoke. The package's four main/preload/renderer files matched the tested build. It was installed at `release/mac-arm64/Crokodial Workspace.app` with `app.asar` SHA-256 `fbf8b66a4cded8a06750195811cc4dc1817d2aaecf3841241729ced9811b66c5`; the prior package remains at `release/backups/workspace-before-4671087/Crokodial Workspace.app`. The normal profile and sign-in were preserved.

Read-only live UI inspection confirmed actual Contacts, name search, Clients filtering, shared saved notes from Contacts and appointments, actual disposition display, appointment History, the Calls filter's empty state for the inspected contact, persistent call/recording controls, return to notes, and retained contact search. The app was left on Contacts. Call/End Call state, elapsed timer, autosave, cursor/scroll restoration, combined timeline ordering, older pages and synthetic recording were verified with isolated fixtures. No customer notes/dispositions were changed, and no real calls or audio capture were started. Sanitized rollout evidence is in the platform repository at `private-sms-app/docs/unified-desktop/workspace-contacts-production-rollout.json`.

## Native macOS window controls — October 12, 2026

Release `ae633fe` replaces the simulated Dialer traffic lights on macOS with the system Close, Minimize, and Zoom/Full Screen controls. A 32-pixel unscaled dark-green drag area stays above loading, sign-in, and all five workspace tabs without covering scaled content. Other platforms retain their existing controls. Native close continues through the existing unsaved-note/audio guard.

Verification passed: typecheck/build; built Notes shell, appointment, and Workspace Electron fixtures; packaged Workspace smoke; isolated native geometry checks at 224×485, 320×693, and 640×1386 across all five tabs; native beforeunload cancellation and clean close. The unchanged backend passed 4,325 tests across 308 suites and all nine finalization gates, including schema validation and controlled identity failures. No backend deployment or migration was needed.

The package was installed at `release/mac-arm64/Crokodial Workspace.app`, preserving the normal profile and restoring sign-in. Its `app.asar` SHA-256 is `96f66b8c499fb74f54abe907704dd84ef657aa51d2de025f488c6d79639d2922`. The previous package remains at `release/backups/workspace-before-ae633fe/Crokodial Workspace.app`. Live native accessibility confirmed all three OS buttons on Dialer and Notes; the green button's native zoom action was exercised and the original size restored. No customer data, calls, or recordings were modified.

## Minimal workspace search, status and calendar — October 12, 2026

Native release `67ac52c` uses a shared magnifier disclosure for Contacts and the Notes appointment list. Search starts collapsed, expands with a short transition, and clears when closed or dismissed with Escape; a populated search remains visible when clicking elsewhere. Contacts and appointments use thin red, yellow, or green strips with accessible status labels. Unbooked leads receive no appointment indicator. The compatible platform release `a542ffe0` supplies owner-scoped canonical appointment evidence through additive contact response fields.

The clickable date opens a single-day adaptation of the web dialer's `MissionDateRangeInput`, retaining its dark/lime tokens, 42-day grid, month controls, positioning and focus behavior. Selection commits immediately; outside clicks and Escape dismiss it. Day arrows and Today remain. Appointment queries, date labels and History use the configured account timezone, including daylight-saving boundaries. Automatic refresh preserves the selected calendar day across midnight and uses “Appointments” when it is not today.

Manual refresh buttons have been removed. Visible contact lists, History, selected notes, search results and assistant metadata refresh automatically on a 30-second interval and focus/visibility events. Loaded contact pages reconcile against fresh keyset pages while preserving the visible anchor. Notes retain revision-aware drafts and focused selection/scroll; selection-target guards prevent stale contact data from crossing views. Saved recording polling retries transient failures with capped backoff. Recording and calling remain explicitly user-started.

Verification passed: typecheck/build; 40 native state/routing/engine tests; all four Electron Contacts/Notes/appointment fixtures; signed packaged Workspace and Notes-shell smoke tests; strict deep code-signature verification. Narrow-window inspection confirmed an unclipped date popup with approximately 37×40-pixel day targets at 320×693. Packaged main, preload, renderer JavaScript and CSS hashes match the tested build. Platform checks passed 4,350 tests across 308 suites, all nine finalization gates, lint, renderer/server validation and script typing. No migration is required.

Platform release `a542ffe0` is live as Railway deployment `e825b51c-87eb-4ca0-b93d-fb354acb715e`. Direct-upload initialization failures were resolved with Railway's exact-commit GitHub deployment from a new release branch, without changing the default branch or service configuration. Four runtime hashes, nine deployed in-memory indicator cases, all eight public checks, database integrity/schema and 226 migration fingerprints passed. The fresh database backup is verified; no migration was added.

The signed native package was installed at `release/mac-arm64/Crokodial Workspace.app` with `app.asar` SHA-256 `0b1cebf18423ce98c28db6ed3ffa075ab3d73c2b96727737a5ec77ed8cbcbb3b`. The previous app is retained at `release/backups/workspace-before-67ac52c/Crokodial Workspace.app`. Graceful restart preserved the profile and restored sign-in. Live inspection confirmed collapsed search in Contacts and Appointments, search expansion/Escape clearing, actual status strips, immediate calendar selection/filtering, distinct selected/today markers, date preservation through automatic refresh, Escape dismissal and Today return. Native traffic lights remain present. The app was left on today's appointments. No customer notes/dispositions were changed, and no calls or recordings were started. Sanitized evidence is in the platform repository at `private-sms-app/docs/unified-desktop/workspace-minimal-production-rollout.json`.

## Compact Contacts toggle — October 12, 2026

Contacts now uses a 124×28-pixel All / Clients pill in place of the three full-width filter buttons. The shared magnifier disclosure remains collapsed by default, with animated expansion and Escape dismissal. History filters, underlying contact membership, automatic refresh and list restoration are unchanged.

Verification passed: `npm run typecheck`, `npm run build`, all 11 `tests/workspace-contacts-state.test.cjs` tests, the Contacts/History Electron fixture, and the installed package's Workspace smoke using an isolated profile. The unchanged platform passed all 4,350 Core tests and nine finalization gates, including schema checks and expected identity failures returning 401/403/400. Four packaged JavaScript/CSS files match the tested build; strict deep signature verification passed after ad-hoc signing with the existing app entitlements.

The package was installed with a graceful restart and the existing sign-in restored. Its `app.asar` SHA-256 is `0abd026a4c1e5ca7e4424b2d9831158478b64d9a26aebdf142b121a7838646ce`; the previous app remains at `release/backups/workspace-before-compact-contacts/Crokodial Workspace.app`. Live inspection confirmed exactly All and Clients, actual client filtering, magnifier expansion, Escape collapse, and the compact dark-green styling. The app was left on All with search collapsed. No backend deployment, migration, customer edits, calls, or recordings were required.


## Contacts Filter & sort — October 12, 2026

Native release `2506cd1` adds the sliders icon beside the collapsed Search control. Its anchored forest-green popover contains Sort by, State, Disposition, Vendor and Timezone, with an active-filter count, Reset, Apply, outside-click dismissal and Escape handling. The compact All / Clients toggle and automatic refresh remain. There is no manual refresh icon. Changes stay in a draft until Apply; Reset resets the draft. The applied-filter summary can clear filters while retaining the chosen sort order.

Platform release `15484669` provides owner-and-tenant-scoped filter options and filtering before pagination. Name A–Z/Z–A and newest/oldest ordering use signed cursors bound to the selected criteria. Native refresh reconciles sorted pages while preserving the visible list anchor. No migration or environment change is required.

Verification passed: 54 focused contact tests; all 4,363 Core tests across 308 suites; nine schema/startup gates; lint, validation and script typing. The exact native commit was rebuilt in an isolated source snapshot to exclude unrelated work in the shared checkout. Typecheck/build, 14 contact state/API tests, Contacts/History, Appointments and Notes-shell fixtures, and the signed package's Workspace smoke passed. The fixtures exercised combined filtering, draft/Apply behavior, Reset, badge count, sorting, pagination, automatic refresh and Escape dismissal with Search open.

Railway deployment `a87ae91b-4c31-46ea-8ccf-ca0afe5f7646` succeeded. The production read-only verifier confirmed four compiled hashes, schema/integrity, 226 migration fingerprints, nine indicator cases and 11 filter cases. All ten public health/authentication checks passed. Bounded current/prior log comparison found no new failure category; checkpoint-lock and Telnyx processing warnings pre-existed. A verified production database backup was taken before deployment.

The native app was installed at `release/mac-arm64/Crokodial Workspace.app`; `app.asar` SHA-256 is `1f74dadacbd7c6d14b833cdb8f60095acf5dcd6cb4815242ca53b8e238d05c6a`. Four packaged main/preload/renderer hashes match the clean build, and strict deep signature validation passed. The previous app is retained at `release/backups/workspace-before-2506cd1/Crokodial Workspace.app`. Live inspection confirmed restored sign-in, actual contacts, the sliders icon and the five-field popover. Apply/Reset were verified in the Electron fixtures; further live clicks stopped when app state changed during inspection. No customer records, calls or recordings were modified. Sanitized release evidence is in the platform repository at `private-sms-app/docs/unified-desktop/workspace-filter-sort-production-rollout.json`.

## Native Personal Assistant workflows (October 18 repair)

This is the native Dialer / Personal Assistant application (`com.crokodial.workspace`), not the retired platform SMS Electron client. The supporting platform is the sibling `CrokodialSMS-1/private-sms-app` repository. Shared backend features are not native UI verification by themselves.

The native conversation restores owner-scoped history and combines saved action receipts with inline work cards. It uses the existing server policies and request UUID ledger. An accepted answer remains visible if a subsequent history read fails; unknown outcomes require explicit retry using the original request identity. Execution progress describes observed request/response stages, not inferred tool execution or email delivery.

- Gmail: a disconnected mailbox displays **Connect Gmail** inside the assistant. Native bearer authentication obtains a one-use, owner-bound browser link for Google consent. It does not require a separate Crokodial web login or expose the bearer in a URL. Returning to the app refreshes mailbox status and resumes the pending email editor. Reply/follow-up history requires separate explicit consent.
- Email: saved drafts, contact selection, corrections, rich formatting, small attachments and linked-thread replies use the platform's revision and digest checks. Review and approval apply to exact content; submitted means provider submission, not confirmed delivery.
- Follow-ups: conditional no-reply tasks reuse the existing thread history, scheduling, expiry and pause/resume/cancel controls. They require a connected mailbox with history permission.
- Screenshots: native multipart image upload, OCR extraction, client matching, field conflict review and exact-preview approval produce a saved CRM receipt. Image transfer is restricted to trusted top-level IPC and fixed platform routes.
- Artifacts: immutable saved versions and an explicit interactive preview. The preview has an opaque origin, no native bridge or same-origin permission, and blocked external resources.
- Background work and approved tools: bounded tasks, calendar/contact/note operations and measured qualification evidence use existing platform services. Unsaved editor changes and pending work block silent discard and normal close/logout; tabs preserve mounted state. Forced termination or forced session invalidation cannot preserve unsaved in-memory content.

Verification commands:

```sh
npm run typecheck
npm run build
node --test tests/assistant-files.test.cjs tests/assistant-workspace-api.test.cjs tests/assistant-session-api.test.cjs tests/session-recovery.test.cjs
node tests/native-workspace.test.cjs
node tests/assistant-workflows-native.test.cjs
```

For end-to-end native-to-server verification, run `npx tsx scripts/verify-native-assistant-workflows.ts` from the supporting platform. It stages this native app against disposable Express/SQLite services, uses actual OCR and native IPC, and controls only model/Google responses. It makes no external email submissions or paid model calls. Live Gmail consent and live delivery are separate from this fixture evidence.

`npm run build` writes `dist/main/workspace-build.json` with source and compiled-file digests. After packaging, run:

```sh
node scripts/workspace-build-identity.mjs --verify-bundle 'release/mac-arm64/Crokodial Workspace.app'
node ../CrokodialSMS-1/scripts/workspace-app.mjs --check
node ../CrokodialSMS-1/scripts/workspace-app.mjs --open
```

The checked launcher refuses a different application or stale compiled source. It preserves the existing `Crokodial Workspace` profile. A matching build digest establishes identity and freshness; the separate native workflow tests establish behavior.

### Unified main chat release — October 18, 2026

Native revision `1c1e149d50281bb8e924e0ff46d6af9913465ca0` is installed at `release/mac-arm64/Crokodial Workspace.app` with bundle ID `com.crokodial.workspace`. Its native source SHA-256 is `36a1f57f34d5715a2060bbffc7acf28aef3ae005f69a3b7df1ab237d7ba8a537`, and its `app.asar` SHA-256 is `5ce90b6f91abf6653a98caa83ec1a9f041daf4c8770179b2908066f8e7fc03a6`. The installed package passed strict deep signing verification and the manifest's source/build parity check.

The Personal Assistant now exposes one continuous server-selected transcript. It has no new-chat, reset or delete path, and the same production history remained visible after launch in the installed app. This verification sent no live email or SMS. Obsolete discoverable `.app` copies were removed from the release tree; the single compressed rollback artifact is `release/backups/Crokodial-Workspace-before-unified-chat-20261018T074629Z.zip`.

## Chat connection and complete email review update

The signed-in owner has one server-owned main conversation. Reloads and application restarts reopen the same conversation; the complete visible transcript remains in its append-only ledger and older pages load into the same interface. The native client does not create, clear, or delete owner chats. If the canonical conversation API is unavailable, the Workspace fails closed instead of opening an ephemeral preview session.

The Personal Assistant consumes typed Gmail prerequisites (`send`, linked `history`, and separately consented `mailbox_read`) from owner conversation responses. Pending original requests remain in the canonical server conversation ledger. The native client reads those requests after reopening the main conversation and offers an explicit **Continue request**. Connecting never resumes or sends automatically. Continuation POSTs use the existing opaque request journal, preserving the request UUID after an uncertain response; original message text is not added to local storage. A changed mailbox blocks continuation until its binding is reconciled or the owner dismisses and asks again in the same main conversation.

The native email editor reviews exact To/CC/BCC recipients with contact, configured support, or owner-provided provenance. Named email templates are owned, versioned workspace templates with verified contact substitutions and required custom fields; they are distinct from generic HTML artifacts and are not presented as Gmail's built-in templates. Template rendering fixes subject, text, HTML and attachments into a reviewable draft. Submitted messages can create a separate editable correction; the submitted original stays immutable. Selected batch reviews show every exact revision and derive their count from that selected set. Uncertain batch decisions require read-only receipt reconciliation before another approval.

The editor also provides a consent-gated mailbox inspector for bounded Inbox/Sent/all search, inert text conversation review, selected attachment downloads and explicit reply-thread selection. Search and thread contents never authorize outgoing messages, and selecting a thread does not silently replace recipients. Attachments share the backend limits: ten files, 5 MiB each and 15 MiB total.

Current source checks: `npm run typecheck`, `npm run build`, and `node --test tests/assistant-connections-email.test.cjs tests/assistant-session-api.test.cjs tests/assistant-workspace-api.test.cjs`. These checks are not evidence of live Google consent, actual delivery, or native user-profile verification. Native fixture coverage remains a separate check; no production account or profile is required by these tests.
