Crokodial Dialer Reconstruction Blueprint

1. The Visual Framework (Components)

Entry Points

RoleFile PathDescriptionMain Dialer Pagepackages/renderer/src/components/Dialer.tsxFull-page lead grid, filters, auto-dialer, dispositionsSoftphone Widgetpackages/renderer/src/components/FloatingDialerWidget.tsxFloating keypad, caller ID dropdown, call controls





Sub-Components

ComponentFile PathPurposeDialerLeadCardpackages/renderer/src/components/DialerLeadCard.tsxLead tiles (compact, maximized, window, row, tile variants)DialerFilterRowpackages/renderer/src/components/DialerFilterRow.tsxFilter row (source, disposition, date range); calls /api/dialer/filter-optionsDialerFilterspackages/renderer/src/components/DialerFilters.tsxFilter UIDialerSettingsModalpackages/renderer/src/components/DialerSettingsModal.tsxKeypad color, ring sounds, keyboard shortcutsDialerSmsActionModalpackages/renderer/src/components/DialerSmsActionModal.tsxQuick SMS from dialerDialerAddLeadModalpackages/renderer/src/components/DialerAddLeadModal.tsxAdd leadDialerEditLeadModalpackages/renderer/src/components/DialerEditLeadModal.tsxEdit leadDialerClosedClientDetailsModalpackages/renderer/src/components/DialerClosedClientDetailsModal.tsxClosed client detailsDialerMaximizedLeadModalpackages/renderer/src/components/DialerMaximizedLeadModal.tsxMaximized lead viewDialerExportModalpackages/renderer/src/components/DialerExportModal.tsxExportDialerDeleteConfirmModalpackages/renderer/src/components/DialerDeleteConfirmModal.tsxDelete confirmationDialerCampaignSelectionModalpackages/renderer/src/components/DialerCampaignSelectionModal.tsxCampaign selectionAutoDialFilterModalpackages/renderer/src/components/AutoDialFilterModal.tsxAuto-dial filtersDialerStatspackages/renderer/src/components/DialerStats.tsxStats pageDialerLeadWindowPagepackages/renderer/src/pages/DialerLeadWindowPage.tsxStandalone lead window





Layout and Controls (FloatingDialerWidget.tsx)

ElementLocationImplementationKeypadLines 1077–11283×4 grid of digits 0–9, , #, plus Backspace | | Caller ID Dropdown | Lines 1002–1024 | <select> with value="auto" and options from effectiveAvailablePhoneNumbers | | Control Bar | Lines 1172–1238 | Answer (power-dialer.png), Decline (PhoneOff), Hang-up (PhoneOff), Mute (Volume2/VolumeX), Hold (Pause/Play), Volume slider | | Phone Input | Lines 1029–1056 | <input type="tel"> for number entry |

### Tailwind / Crokodial Green

| Token | Usage | |-------|-------| | #84cc16 | CampaignHub SVG stop (stopColor="#84cc16") | | lime-400, lime-500, lime-600 | Buttons, accents, focus rings | | #34C759 | Call button green in FloatingDialerWidget (line 1199) | | #6b7635, #48541f, #3f4e1f | primaryColor, secondaryColor, keypadColor in dialer settings | | #1a3d1a | Border color on dialer shell |

Dialer colors are driven by DialerSettingsType (primaryColor, secondaryColor, keypadColor), persisted in localStorage as dialerSettings.

---

## 2. The Telephony Engine (Hooks & WebRTC)

### Service

| File | Purpose | |------|---------| | packages/renderer/src/services/telnyxService.ts | WebRTC logic over Telnyx SDK |

### SDK and Events

- SDK: @telnyx/webrtc (TelnyxRTC) - Events: telnyx.ready, telnyx.socket.open, call.statechange, call.dtmf - Call creation: client.newCall({ destinationNumber, callerNumber, callerName }) - DTMF: currentCall.dtmf(digit) (line 1383); sendDTMF exported but not wired in the UI for active calls

### Lifecycle Functions

| Function | Purpose | |----------|---------| | initializeTelnyxClient(config) | Create client with username/password or login_token | | startCall(options) | Outbound call; options include destinationNumber, callerNumber, callerName, leadContext | | hangupCall() | End current call | | answerCall() | Answer inbound call | | toggleMute() | Mute/unmute via audioTrack.enabled | | toggleHold() | Hold/resume via call.hold() | | sendDTMF(digit) | Send DTMF for digit 0–9, *, # | | disconnectTelnyxClient() | Clean disconnect |

### Flow: Keypad → Call

1. User enters number in input or via keypad. 2. Enter key or Call button calls handleStartCall(). 3. resolveCallerNumber() chooses caller ID (Auto or selected number). 4. startCall({ destinationNumber: phoneNumber, callerNumber, callerName, leadContext }). 5. Telnyx emits trying → ringing → active (or ended). 6. UI subscribes via onCallStateChange() and onConnectionStatusChange().

### Audio

- Local stream: getUserMedia → currentLocalStream → passed to newCall(). - Remote stream: remoteAudioElement attached to call’s remote stream. - Volume: getVolume(), setVolume() in telnyxService.ts. - Ring tones: inboundRingSound, outboundRingSound from settings (optional, URLs). - Keypad click: keypadClickSound in DialerSettingsType (optional).

---

## 3. Identity & Routing Layer (Backend Integration)

### Services and Endpoints

| Endpoint | File | Purpose | |----------|------|---------| | GET /api/phone-numbers | phoneNumbers.ts | List phone numbers for caller ID | | GET /api/phone-numbers/user-assignments | phoneNumbers.ts | User’s assigned numbers | | GET /api/dialer/leads | dialer.ts | Lead list with filters | | GET /api/dialer/filter-options | dialer.ts | Filter options | | POST /api/dialer/call | dialer.ts | Log call start, increment total_calls | | POST /api/dialer/contacts/:id/disposition | dialer.ts | Save disposition | | PUT /api/dialer/contacts/:id/client-status | dialer.ts | Set client status |

### Caller ID Selection

| File | Role | |------|------| | packages/renderer/src/utils/callerNumberSelection.ts | selectCallerNumber() – state/area-code matching and rotation | | packages/renderer/src/utils/floatingDialerCallerNumber.ts | resolveCallerNumber() – Auto vs manual with user assignments |

Flow:

- Auto: Filter by userAssignments, then selectCallerNumber() by lead state. - Manual: Use selected E.164 if present in availableNumbers and userAssignments.

### Inbound vs Outbound

| Direction | Source | Flow | |-----------|--------|------| | Inbound | onIncomingCall() | Notification → openDialer() → Answer/Decline | | Outbound | handleStartCall() | Number + caller ID → startCall() → onCallStateChange |

---

## 4. Asset Manifest

### Icons (lucide-react)

| Icon | Usage | |------|-------| | Phone | Start call, call button | | PhoneOff | Hang-up, decline | | Volume2 / VolumeX | Mute toggle | | Pause / Play | Hold toggle | | X, Minus, Maximize2 | Dialer window controls | | ChevronLeft, ChevronRight | Toolbar expand | | MessageSquare | SMS tab |

### Images

| Asset | Path | Usage | |-------|------|-------| | power-dialer.png | /power-dialer.png (public) | Answer and launcher buttons | | loading.png | /loading.png | LCP preload, loading state | | favicon.png | /favicon.png | Favicon | | logo.png | /logo.png | Brand logo |

### Audio (Optional, User-Configured)

| Setting | Key | Default | |---------|-----|---------| | Inbound ring | inboundRingSound | null | | Outbound ring | outboundRingSound | null | | Keypad click | keypadClickSound | null |

Stored as URLs in localStorage.dialerSettings. No bundled DTMF or ringback files; audio elements are created dynamically when URLs are set.

---

## 5. File Manifest (Categorized)

### Components



packages/renderer/src/components/

  Dialer.tsx

  FloatingDialerWidget.tsx

  DialerLeadCard.tsx

  DialerFilterRow.tsx

  DialerFilters.tsx

  DialerSettingsModal.tsx

  DialerSmsActionModal.tsx

  DialerAddLeadModal.tsx

  DialerEditLeadModal.tsx

  DialerClosedClientDetailsModal.tsx

  DialerMaximizedLeadModal.tsx

  DialerExportModal.tsx

  DialerDeleteConfirmModal.tsx

  DialerCampaignSelectionModal.tsx

  AutoDialFilterModal.tsx

  AutoDialResumeOrResetModal.tsx

  DialerStats.tsx

  dialerTypes.ts

packages/renderer/src/pages/

  DialerLeadWindowPage.tsx











### Telephony and Routing



packages/renderer/src/services/

  telnyxService.ts

packages/renderer/src/utils/

  callerNumberSelection.ts

  floatingDialerCallerNumber.ts

packages/renderer/src/hooks/

  useAutoDialer.ts











### Backend



packages/main/src/server/routes/

  dialer.ts

  phoneNumbers.ts

  autoDialer.ts

packages/main/src/services/

  dialerAutoSendService.ts











### Lazy Loading



packages/renderer/src/lazySections.tsx  (LazyDialer, LazyFloatingDialerWidget, LazyDialerStats, LazyDialerLeadWindowPage)











---

## 6. Logic Flow: Number → Live Call





















User enters number in input or keypad

Press Enter or click Call

resolveCallerNumber: Auto or manual

Fetch /api/phone-numbers if needed

selectCallerNumber or use selected E.164

startCall with destinationNumber, callerNumber, leadContext

Telnyx WebRTC: SIP INVITE

Call state: trying → ringing

User answers or declines

State: active or ended

POST /api/dialer/call to log

On hangup: cleanup, onCallEnd

---

## 7. State Schema (State Machine)

| Variable | Type | Description | |----------|------|-------------| | connectionStatus | 'disconnected' \| 'connecting' \| 'connected' \| 'registered' \| 'error' | WebRTC registration | | uiState | 'idle' \| 'dialing' \| 'ringing' \| 'in_call' \| 'held' \| 'ended' | UI call phase | | currentCall | Call \| null | Active Telnyx call | | isMuted | boolean | Mic muted | | isOnHold | boolean | Call on hold | | phoneNumber | string | Input / dialed number | | selectedCallerNumber | string | 'auto' or E.164 | | volume | number | 0–100 | | pressedKey | string \| null | Keypad visual feedback | | isOpen | boolean | Widget open | | isMinimized | boolean | Widget minimized | | dialerPosition | { x, y } | Draggable position | | currentCallLeadContext | { leadId, leadName, leadPhone } \| null | Lead context for active call |

---

This is the full blueprint needed for a 1:1 reconstruction of the Crokodial Dialer.