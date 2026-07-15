# Frontend task: dashboard "Load older" (B) + click-to-load media (D3)

## Where this fits
OpenWA is switching to the Baileys engine so the full message archive lands in the `messages` table on connect. The API already paginates that table via `offset` (`GET /api/sessions/:sessionId/messages?chatId=…&limit=100&offset=N` → `{messages, total}`), but the dashboard loads a fixed 100-message window per chat with no way to page back, so even a full DB only shows the newest ~100. A parallel backend task is adding a media endpoint `GET /api/sessions/:sessionId/messages/:waMessageId/media` (OPERATOR-gated, streams bytes; auth via `X-API-Key` header) that downloads history media on demand and caches it in S3. This task makes the web UI actually show full history (B) and lets users click to load media that arrived as placeholders (D3).

Read the plan first for full context: `C:\Users\chrono1010\.claude\plans\eventual-dreaming-orbit.md` (Parts B and D3).

**Backend contract you depend on (being built in parallel — do NOT edit backend files):**
- `GET /api/sessions/:sessionId/messages?chatId=<jid>&limit=<1..100>&offset=<0..>` → `{ messages: ChatMessage[]; total: number }` (already exists; you just need to pass `offset`).
- `GET /api/sessions/:sessionId/messages/:waMessageId/media` → binary stream with `Content-Type: <mimetype>`. Auth: `X-API-Key` header (same as all other calls). 404 if no downloadable copy exists. This endpoint is OPERATOR-gated — only role-permitted keys can call it; the dashboard already holds an operator key for writes, so this is fine.

## Current state (verified, do not re-read unless needed)
- `dashboard/src/services/api.ts:465` — `getChatMessages(id, chatId, limit=100)` → no `offset`. There is also `getChatHistory(id, chatId, limit=100, includeMedia=false)` (live engine history; returns 501 under Baileys — keep as the cold-start fallback it already is; do NOT change its usage).
- `dashboard/src/services/api.ts:359` — `request<T>(endpoint, options)` injects `X-API-Key` from `sessionStorage`. `:407` — `requestText(endpoint)` (text variant, also injects the key). Neither returns binary/Blob.
- `dashboard/src/hooks/useChatMessages.ts` — `useChatMessages(sessionId, chatId|null)` runs a `Promise.allSettled([getChatMessages(100), getChatHistory(100,false)])` and `mergeChatMessages(db, history)`. `queryKey = ['messages', sessionId, chatId]`, `staleTime: Infinity`, `gcTime: 5min`. `useChatMessagesActions()` exposes `appendMessage`/`updateMessage`/`removeMessage` writing to the cache.
- `dashboard/src/utils/chatMessages.ts` — `mergeChatMessages(db, history)` dedups by `msgKey = m.waMessageId ?? m.id`, sorts ascending by `msgTime` (timestamp epoch-seconds, fallback `Math.floor(Date.parse(createdAt)/1000)`). `msgKey`/`msgTime` are module-private (not exported). `ChatMessageView` type + `MessageMedia = {mimetype, filename?, data?, omitted?, sizeBytes?}`.
- `dashboard/src/pages/Chats.tsx`:
  - `:46` local `MessageMedia` type (same shape).
  - `:77` `getMediaSrc(media)` returns `''` when no `media.data`; passes through `data:`/`http(s):`; else wraps `data:${mimetype};base64,${data}`.
  - `:103-107` `useChatMessages(selectedSessionId, activeChat?.id ?? null)` → `{data: messages = []}`.
  - `:135` `useChatScrollPosition(activeChat?.id, messages.length>0)` → `{containerRef: messagesContainerRef, onMessageAppended}`.
  - `:872` `<div className="room-messages" ref={messagesContainerRef}>` is the scroll container.
  - `:889` `messages.map(msg => …)`; `:896` `mediaInfo = msg.metadata?.media`; `:898` `renderMedia()`.
  - `:934-935` the omitted placeholder: `if (mediaInfo.omitted) return <div className="message-media-omitted">📎 {t('chats.media.omitted')}</div>;` — this is the D3 hook point.
  - `:940-982` image/video/audio/document branches all render from `mediaSrc = getMediaSrc(mediaInfo)` (`<img src>`, `<video src>`, `<audio src>`, `<a href download>`).
  - Styles: custom CSS classes (`message-media-omitted`, `btn-secondary`, etc.) + `lucide-react` icons + `react-i18next` `useTranslation` (`t`).
- `dashboard/src/hooks/useChatScrollPosition.ts` — handles per-chat scroll memory + chat-switch restore + `onMessageAppended` auto-stick-to-bottom. Does NOT handle prepend-anchor (loading older messages prepends above the current top — the viewport must not jump).
- i18n: 11 locale files under `dashboard/src/i18n/locales/` (`en`, `es`, `he`, `zh-CN`, `zh-HK`, `ar`, `te`, `fr`, `it`, `pt-BR`, `ko`), loaded in `dashboard/src/i18n/index.ts`. `en.json` is authoritative. Existing keys: `chats.media.omitted` ("Media"), `chats.media.image` ("Image"), `chats.downloadDocument` ("Download document").

## B — Load-older pagination

### `dashboard/src/services/api.ts`
- `getChatMessages(id, chatId, limit=100, offset=0)` → append `&offset=${offset}` to the URL. Keep the existing `ChatMessage[]/total` return type.

### `dashboard/src/utils/chatMessages.ts`
- Export `msgKey` and `msgTime` (or export a `prependChatMessages(existing, older)` helper that uses them — preferred, mirroring `mergeChatMessages`). `prependChatMessages(existing: ChatMessageView[], older: ChatMessageView[]): ChatMessageView[]`:
  - Build a Map keyed by `msgKey`; insert `older` first, then `existing` (existing wins on conflict — the already-loaded copy is authoritative).
  - Return sorted ascending by `msgTime` then `createdAt.localeCompare` — identical ordering to `mergeChatMessages`.
  - Do NOT mutate inputs.
  If you export `msgKey`/`msgTime` instead, `prependChatMessages` can reuse them; either way, keep ONE sort/dedup code path (factor the shared comparator so `mergeChatMessages` and `prependChatMessages` can't drift). A tiny shared `dedupAndSort(all)` internal used by both is the cleanest.

### `dashboard/src/hooks/useChatMessages.ts`
- Capture `total` from the initial `getChatMessages` response (currently discarded — the `Promise.allSettled` takes only `.messages`). Surface it from the hook so Chats.tsx can decide `hasOlder`. Approach: change the `queryFn` to return `{ messages, total }` (a small object) instead of bare `ChatMessageView[]`, and update the `useQuery<…>` type param + all consumers (`useChatMessagesActions` reads the cache as `ChatMessageView[]` — keep the CACHE shape as `ChatMessageView[]` by storing only `messages` in the cache and holding `total` in a SEPARATE query, OR keep the cache as the array and return total via a sibling `useQuery(['messages-total', sessionId, chatId])`).
  - **Chosen approach (do this):** keep the React Query cache for messages as `ChatMessageView[]` (unchanged — `useChatMessagesActions` and all WS writers stay array-based, zero churn). Add `total` by having the `queryFn` stash it in a tiny sibling cache via `qc.setQueryData(['messages-total', sessionId, chatId], total)` is NOT allowed inside queryFn cleanly — instead, return `{ messages, total }` from queryFn and use `select` to project to `ChatMessageView[]` for the cache while exposing `total` via the `data` object. Concretely: change the hook to `useQuery<{messages: ChatMessageView[]; total: number}, Error>(…)` with `select: d => d.messages` is wrong (select changes what the hook returns, not what's cached). Simplest correct approach: keep cache as the array (queryFn returns `ChatMessageView[]`), and add a SECOND `useQuery` in the same file — `useChatMessagesTotal(sessionId, chatId)` with key `['messages-total', sessionId, chatId]` whose queryFn calls `getChatMessages(sessionId, chatId, 1, 0)` just to read `.total` (cheap: limit=1). Export both `useChatMessages` (unchanged signature/return) and `useChatMessagesTotal`. Chats.tsx calls both.
  - Add and export `useLoadOlderMessages(sessionId, chatId)`: a `useMutation` that takes `offset` (= current loaded count), calls `getChatMessages(sessionId, chatId, 100, offset)`, and on success updates the messages cache by prepending: `qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), old => prependChatMessages(old ?? [], newer))`. Also update the total cache from the response (`qc.setQueryData(['messages-total', …], res.total)`). Return the mutation (`mutate`/`mutateAsync`, `isPending`, `isError`).
  - "Load older" hits the DB endpoint only (NOT the engine `getChatHistory` — it has no offset/total and 501s under Baileys). The engine-history `Promise.allSettled` in `useChatMessages` stays as the cold-start fallback for the empty-DB/freshly-paired case — leave it.

### `dashboard/src/pages/Chats.tsx`
- Wire `useChatMessagesTotal(selectedSessionId, activeChat?.id ?? null)` → `total`. Wire `useLoadOlderMessages(selectedSessionId, activeChat?.id ?? null)` → `{ mutate: loadOlder, isPending: loadingOlder }`.
- `hasOlder = messages.length < total` (total defaults to messages.length when undefined → no button until total known).
- Render a "Load older" control at the TOP of `.room-messages` (before `messages.map`), only when `hasOlder` and the chat is loaded. Use a `btn-secondary`-styled button (match existing button classes) with the `chats.loadOlder` i18n key. Show a spinner/disabled state while `loadingOlder`. On click → `loadOlder(messages.length)`.
- **Scroll anchor on prepend (critical):** prepending older messages grows `scrollHeight` above the current viewport; without anchoring the view jumps. Add a `useLayoutEffect` (or extend the existing scroll handling) that, when messages are prepended (detected by comparing the count/first-id before vs after), preserves the viewport: snapshot `scrollHeight - scrollTop` (distance from bottom) OR the offsetTop of the previously-first message BEFORE the mutation commits, and restore it AFTER the new messages render. The cleanest: before calling `loadOlder`, capture `const el = messagesContainerRef.current; const first = el?.firstElementChild as HTMLElement | null; const firstTop = first?.offsetTop ?? 0; const prevScrollTop = el?.scrollTop ?? 0;` and store in a ref; in a `useLayoutEffect` keyed on `messages.length`, if we just prepended, set `el.scrollTop = prevScrollTop + ((el.firstElementChild as HTMLElement)?.offsetTop ?? 0) - firstTop`. Guard so chat-switch restore (handled by `useChatScrollPosition`) and append-to-bottom (handled by `onMessageAppended`) are not disturbed. Implement an explicit `prependAnchorRef` to distinguish "this render is a prepend" from normal appends/switches.
  - Reuse `messagesContainerRef` from `useChatScrollPosition` (it's the same `.room-messages` div). Do NOT add a second ref to the same element.

### i18n
- Add `chats.loadOlder` ("Load older") to `en.json` and to ALL 11 locale files with proper translations (es, he, zh-CN, zh-HK, ar, te, fr, it, pt-BR, ko). Add `chats.loadingOlder` ("Loading…") for the spinner state too. Add `chats.media.loadMedia` ("Load media") and `chats.media.loadMediaFailed` ("Failed to load media") for D3.

## D3 — Click-to-load media

### `dashboard/src/services/api.ts`
- Add a binary fetch helper, e.g. `fetchMessageMedia(sessionId, waMessageId): Promise<Blob>` that does `fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(waMessageId)}/media`, { headers: { ...(apiKey ? {'X-API-Key': apiKey} : {}) } })` and throws on non-ok. Reuse the same `sessionStorage` key + 401 handling pattern as `request`/`requestText` (on 401, clear key + redirect to `/` — factor the small 401 handler into a shared internal if practical, else mirror it inline). Return `response.blob()`.

### `dashboard/src/pages/Chats.tsx` — the omitted placeholder (`:934`)
Replace `if (mediaInfo.omitted) return <div className="message-media-omitted">📎 {t('chats.media.omitted')}</div>;` with a clickable control. Behavior:
- Render a button (matching `btn-secondary` style) labeled `t('chats.media.loadMedia')` (with the media type icon). On click:
  - Call `fetchMessageMedia(selectedSessionId, msg.waMessageId ?? msg.id)`.
  - On success: `const url = URL.createObjectURL(blob)`; store it in a per-message local state map (e.g. `useState<Record<string, string>>({})` for `loadedMediaUrls`, keyed by `msg.id`; revoke the previous blob URL when replacing).
  - Build a synthetic `mediaInfo`-like object with `data: url` so the existing `getMediaSrc` (which passes through `http(s):`/`data:` — note: a `blob:` URL is NOT matched by the current `getMediaSrc` prefix check; you must ALSO add `media.data.startsWith('blob:')` to `getMediaSrc`'s pass-through, OR set the blob URL directly as `src`). Simplest: extend `getMediaSrc` to also pass through `blob:` URLs.
  - Once loaded, render the SAME image/video/audio/document branches as existing media (reuse `renderMedia`'s switch by setting `mediaInfo = { ...mediaInfo, data: url }` and falling through to the existing switch). Implement this as: when a blob URL is loaded for this message, override `mediaInfo` with `{...mediaInfo, omitted: false, data: url}` and let the code below render normally.
  - On failure: show `t('chats.media.loadMediaFailed')` (replace the button label) and allow retry.
- Keep a per-message `loading` state to disable the button while fetching (a `Record<string, boolean>` or a small inline state).
- Guard: only render the load button when `mediaInfo.omitted` is true AND the message has a `waMessageId` (history media always has one). If no id, fall back to the current static placeholder.

### `getMediaSrc` (`:77`)
- Add `media.data.startsWith('blob:')` to the pass-through branch (so blob URLs work without re-encoding).

### i18n
- `chats.media.loadMedia` + `chats.media.loadMediaFailed` (added above in B's i18n step — do it once for both).

## Hard constraints
- Match the existing code style: 2-space indent, the explanatory-comment style in these files, named exports, `useTranslation` (`t`) for all user-facing strings (NO hard-coded English). Functional React + hooks; `lucide-react` icons; CSS classes from `Chats.css` (add new classes there if needed, matching existing conventions — do NOT introduce a new styling system).
- Do NOT touch any backend (`src/`) files. Do NOT touch `.env`.
- Keep `staleTime: Infinity` semantics: "Load older" must NOT reset/prefetch the whole slice — only prepend the older page. Real-time WS appends must continue to dedup by `waMessageId ?? id` and not reset paging. Refresh `total` from the load-older response.
- Revoke object URLs on unmount/replace to avoid leaks.
- Run the dashboard type-check + tests and report: `cd dashboard && npx tsc --noEmit` and `npx vitest run` (if a vitest config exists — check `dashboard/package.json`; if no test runner, run `tsc --noEmit` only and say so). Add focused tests for `prependChatMessages` (dedup + ascending order, existing-wins) and the `getMediaSrc` blob pass-through if a vitest setup exists for utils; mirror any existing test file conventions. Do NOT run the Docker build.

## Files you will edit
- `dashboard/src/services/api.ts` (getChatMessages offset; fetchMessageMedia blob helper)
- `dashboard/src/utils/chatMessages.ts` (prependChatMessages; shared dedup/sort; maybe export msgKey/msgTime)
- `dashboard/src/hooks/useChatMessages.ts` (useChatMessagesTotal; useLoadOlderMessages)
- `dashboard/src/pages/Chats.tsx` (Load older control + scroll anchor; omitted-placeholder click-to-load; getMediaSrc blob pass-through; per-message loaded-media state)
- `dashboard/src/i18n/locales/*.json` (11 files: loadOlder, loadingOlder, media.loadMedia, media.loadMediaFailed)
- `dashboard/src/pages/Chats.css` (only if a new class is needed)
- (tests) `dashboard/src/utils/chatMessages.spec.ts` or equivalent if a test runner exists

## Report contract
Write your full report to `D:\OpenWA\OpenWA\.sdd-briefs\task-frontend-history-report.md`: files edited with summaries, how total/hasOlder/scroll-anchor are implemented, the exact i18n keys added per locale, test commands run + output (tsc + vitest if present), concerns/deviations, and commit hashes. Commit on `main`. Return only: status (DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT), commit range, one-line test summary, concerns.