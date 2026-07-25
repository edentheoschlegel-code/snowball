/* Snowball — 100% in-browser debt payoff planner. No network at runtime.
 * All state lives in localStorage on this device only.
 *
 * SECURITY: every field here is attacker-controlled (debt names especially),
 * so dynamic strings are ALWAYS written via textContent — never interpolated
 * into innerHTML. A strict CSP (see index.html) enforces the no-upload
 * promise at the browser level. */
"use strict";

const STORAGE_KEY = "snowball.v1";
// "1" once the user has confirmed they saved their Pro license card — until
// then a boot-time nag banner keeps resurfacing it (the code is the ONLY way
// back into Pro, so losing it silently is the worst outcome this app has).
const CODE_ACK_KEY = "snowball.code_ack";
// "1" once the one-time ownership celebration has fired — so unlocking Pro feels
// like a warm moment exactly once, and never resurfaces on later visits or restores.
const CELEBRATED_KEY = "snowball.celebrated";
// "1" while this browser is known-Pro. Set after any refresh that reads
// isPro()===true; consulted after later refreshes so a genuine verified
// revocation (refund/expiry) — isPro() flips from true→false — is detected and
// handled kindly ONCE. Never set from a mere offline blip, because
// refreshProStatus() fails OPEN for known owners offline (isPro() stays true),
// so this only flips on a real server "not active".
const WAS_PRO_KEY = "snowball.was_pro";
// ISO timestamp of the last Data Vault export ON THIS DEVICE. Kept OUT of `state`
// (its own key) so importing an old backup can't overwrite "when did I last
// protect my data here" — the whole point is honest local data-loss defense.
const LAST_BACKUP_KEY = "snowball.last_backup";
// "1" once the student-loan advisory has been acknowledged, so the honest
// heads-up shows gently and doesn't nag on every later visit.
const SL_ADVISORY_KEY = "snowball.sl_advisory_ack";
// The Pro "reward photo" — a downscaled goal image, kept in its OWN key (never in
// the vault) so it stays private to this device and doesn't bloat backups.
const REWARD_PHOTO_KEY = "snowball.reward_photo";
function getRewardPhoto() { try { return localStorage.getItem(REWARD_PHOTO_KEY) || null; } catch { return null; } }
function setRewardPhoto(dataUrl) { localStorage.setItem(REWARD_PHOTO_KEY, dataUrl); }
function clearRewardPhoto() { try { localStorage.removeItem(REWARD_PHOTO_KEY); } catch { /* private mode */ } }
const SUPPORT_EMAIL = "support@mysnowballapp.com";
// True only inside the Capacitor iOS/Android shell. On iOS, Pro is bought via Apple
// In-App Purchase (Guideline 3.1.1) — so the paywall/success/restore UI must NOT reference
// Stripe checkout, email receipts, "your statement", or the web-only restore-CODE mechanism.
// Every use is `if (IS_NATIVE) {…} else {…exact existing web copy…}` so the live web build is
// byte-for-byte unchanged.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// iOS is an app, not a browser — rewrite the web-only "in-browser" footer tagline on native so
// it reads as an app (and never trips Apple's "repackaged website" review, Guideline 4.2). The
// live web build never enters this branch, so its copy is byte-for-byte unchanged. app.js runs
// at end-of-body, so the footer nodes already exist here and their click handlers are wired
// further below — after this string-replace re-parses the footer — so nothing is left unbound.
if (IS_NATIVE) {
  const applyNativeCopy = () => {
    const ft = document.querySelector("footer");
    if (ft && /in-browser/i.test(ft.innerHTML)) ft.innerHTML = ft.innerHTML.replace(/a private, in-browser debt payoff planner/i, "a private, on-device debt payoff planner");
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyNativeCopy);
  else applyNativeCopy();
}
// Identifies this app's backups so a LocalResume/Local Invoice vault file
// can't be imported here by mistake.
const VAULT_APP_ID = "snowball";
const MAX_MONEY = 999999999.99;
const MAX_APR = 200; // generous upper bound (real-world cards top out well under this) — just a sanity cap, not a realism claim
const CAP_MONTHS = 600; // 50-year circuit breaker so a debt that can never be paid off (min payment below interest) can't hang the simulator in an infinite loop

// ── DOM helpers (textContent-only for anything not a developer constant) ──
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const txt = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
// Custom celebration mark (party popper) — flat, on-brand, themes via currentColor.
// Replaces the plain 🎉 emoji on the "Paid off" badge + the debt-free marker.
const CELEBRATE_SVG = '<svg class="celebrate-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13.4 9 C16 6.6 18.6 6.6 21 8.2" stroke="#22d3ee" stroke-width="1.6" stroke-linecap="round" fill="none"/><path d="M2.8 21.2 L12.8 8 L17.8 13 Z" fill="currentColor"/><path d="M6.2 16.6 L9.6 19.2" stroke="#bdeef7" stroke-width="1.8" stroke-linecap="round"/><path d="M8.7 13.3 L12.1 15.9" stroke="#bdeef7" stroke-width="1.8" stroke-linecap="round"/><circle cx="17.7" cy="5.4" r="1.7" fill="#f59e0b"/><circle cx="21.1" cy="11.4" r="1.5" fill="#fb7185"/><rect x="19.5" y="14.3" width="2.7" height="2.7" rx=".6" transform="rotate(22 20.8 15.6)" fill="#22d3ee"/><circle cx="14.2" cy="4" r="1.2" fill="#22d3ee"/></svg>';

// pdf-lib (window.PDFLib) builds the exported payoff-plan PDF (Pro feature).
// Lazily loaded (~200KB) only when the user actually exports — most visitors
// never do, so it stays out of the initial page load. The service worker caches
// it after first use (offline export works once you've exported online once).
let _pdfLibPromise = null;
function ensurePdfLib() {
  if (window.PDFLib) return Promise.resolve();
  if (!_pdfLibPromise) {
    _pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "lib/pdf-lib.min.js"; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { _pdfLibPromise = null; reject(new Error("pdf-lib failed to load")); };
      document.head.appendChild(s);
    });
  }
  return _pdfLibPromise;
}
// Destructured lazily inside the exporter so a missing lib can never break boot.
// pdf-lib's standard fonts only cover WinAnsi — strip anything outside it so
// drawText never throws on emoji/exotic unicode pasted into a debt name.
const pdfSafe = (s) => String(s || "").replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "");

// ── Screen-reader announcements ────────────────────────────────────────
// Many status messages (PDF export result, restore errors, save state) are
// injected into or removed from the DOM, so assistive tech won't notice them
// unless the text lands in a persistent live region. Two always-present,
// visually-hidden nodes do that: a polite one for info/success and an
// assertive one for errors. announce() clears then re-sets the text so an
// identical repeat message still fires.
let _politeRegion = null, _alertRegion = null;
function ensureLiveRegions() {
  if (_politeRegion && _alertRegion) return;
  const mk = (role, live) => {
    const n = document.createElement("div");
    n.setAttribute("role", role);
    n.setAttribute("aria-live", live);
    n.setAttribute("aria-atomic", "true");
    n.className = "sr-only";
    document.body.appendChild(n);
    return n;
  };
  _politeRegion = mk("status", "polite");
  _alertRegion = mk("alert", "assertive");
}
function announce(message, isError) {
  ensureLiveRegions();
  const region = isError ? _alertRegion : _politeRegion;
  region.textContent = "";
  // A microtask gap lets AT register the clear→set as a change even when the
  // new text equals the old.
  requestAnimationFrame(() => { region.textContent = String(message || ""); });
}

const genId = () => "d_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// Strips currency symbols/commas/spaces but keeps digits, one decimal point,
// a leading sign, and exponent notation (e/E) intact so parseFloat can read
// scientific notation ("1e6") correctly instead of the "e" being stripped
// first and the surrounding digits silently splicing into a wrong number.
const safeNumber = (v, { min = 0, max = MAX_MONEY } = {}) => {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.eE+\-]/g, ""));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
};
const money = (n) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const moneyPrecise = (n) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
function monthsLabel(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 months";
  const y = Math.floor(n / 12), m = n % 12;
  const parts = [];
  if (y) parts.push(`${y} yr${y === 1 ? "" : "s"}`);
  if (m || !y) parts.push(`${m} mo${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}
// setMonth() alone overflows into the wrong month for high day-of-month
// dates (e.g. Jan 31 + 1mo naively lands on Mar 3, not Feb 28) because Feb
// only has 28/29 days. Land on the 1st of the target month first, then
// clamp the original day to that month's actual last day.
function addMonths(date, n) {
  const target = new Date(date.getFullYear(), date.getMonth() + n, 1);
  const lastDayOfTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDayOfTarget));
  return target;
}
function formatDate(d) { return d.toLocaleDateString("en-US", { month: "long", year: "numeric" }); }

// ── Storage (all state lives on-device; corrupt/missing data never crashes the app) ──
// Optional 0%/intro-rate promo on a debt: the debt's `apr` is the CURRENT (promo)
// rate; after `endMonth` it jumps to `postApr`. `deferred` = a deferred-interest
// offer (unpaid balance triggers back-interest at the deadline). Null when absent.
function sanitizePromo(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.endMonth !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw.endMonth)) return null;
  return {
    endMonth: raw.endMonth,
    postApr: safeNumber(raw.postApr, { min: 0, max: MAX_APR }),
    deferred: !!raw.deferred,
  };
}
function sanitizeDebt(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : genId(),
    name: typeof raw.name === "string" ? raw.name : "",
    balance: safeNumber(raw.balance, { min: 0, max: MAX_MONEY }),
    apr: safeNumber(raw.apr, { min: 0, max: MAX_APR }),
    minPayment: safeNumber(raw.minPayment, { min: 0, max: MAX_MONEY }),
    // Real credit-card minimums shrink with the balance. Opt-in per debt: when
    // "percent", the monthly minimum = (minPercent% of balance + interest), with
    // the entered minPayment as the floor. Default "fixed" = the classic flat min.
    minKind: raw.minKind === "percent" ? "percent" : "fixed",
    minPercent: safeNumber(raw.minPercent, { min: 0, max: 100 }),
    promo: sanitizePromo(raw.promo),
  };
}
function blankState() {
  return { strategy: "snowball", extraPayment: 0, debts: [{ id: genId(), name: "", balance: 0, apr: 0, minPayment: 0 }], checkins: [], closedDebts: [], ledger: [], customOrder: [] };
}
// The user's own payoff order (a list of debt ids) for the "Custom" strategy.
function sanitizeCustomOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(); const out = [];
  for (const id of raw) { if (typeof id === "string" && id && !seen.has(id)) { seen.add(id); out.push(id); if (out.length >= 500) break; } }
  return out;
}
// The strategy to compare the current pick against: always the other algorithm,
// and for a custom order, Avalanche (the cheapest) so the trade-off is honest.
function otherStrategy(chosen) { return chosen === "avalanche" ? "snowball" : "avalanche"; }
// The living ledger — each real monthly log is a reversible record of what was
// actually paid per debt (with the interest charged and the balance before/after),
// so balances become a true record instead of a static projection. Part of state,
// so it rides the vault; hard-sanitized so corrupt/hostile data can never crash.
function sanitizeLedgerEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw.month)) return null;
  const entries = Array.isArray(raw.entries) ? raw.entries.map((e) => {
    if (!e || typeof e !== "object" || typeof e.debtId !== "string" || !e.debtId) return null;
    return {
      debtId: e.debtId,
      paid: safeNumber(e.paid, { min: 0, max: MAX_MONEY }),
      interest: safeNumber(e.interest, { min: 0, max: MAX_MONEY }),
      before: safeNumber(e.before, { min: 0, max: MAX_MONEY }),
      after: safeNumber(e.after, { min: 0, max: MAX_MONEY }),
    };
  }).filter(Boolean) : [];
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : genId(),
    month: raw.month,
    at: typeof raw.at === "string" ? raw.at : "",
    kind: raw.kind === "snowflake" ? "snowflake" : "month",
    source: typeof raw.source === "string" ? raw.source.slice(0, 40) : "",
    entries,
  };
}
function sanitizeLedger(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeLedgerEntry).filter(Boolean).slice(-600); // ~50 years of monthly logs
}
// Payment check-ins (Snowpack) — an opt-in, private list of "YYYY-MM" months the
// user confirmed they made their payments. Empty by default; rides the backup
// vault (it's part of state). Sanitized hard so corrupt/hostile data never crashes.
function sanitizeCheckins(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const m of raw) {
    if (typeof m !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= 1200) break; // 100 years — a sane cap
  }
  out.sort();
  return out;
}
const monthKeyNum = (m) => { const [y, mo] = m.split("-").map(Number); return y * 12 + (mo - 1); };
function currentMonthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function monthKeyLabel(m) { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
// Consecutive months ending at the most recent check-in. Forgiving: a gap just
// starts a fresh streak; the running total of logged months is kept separately.
function checkinStreak(checkins) {
  if (!checkins || !checkins.length) return 0;
  const sorted = [...checkins].sort();
  let streak = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (monthKeyNum(sorted[i]) - monthKeyNum(sorted[i - 1]) === 1) streak++;
    else break;
  }
  return streak;
}
function logThisMonthPayment() {
  const key = currentMonthKey();
  if (!Array.isArray(state.checkins)) state.checkins = [];
  if (!state.checkins.includes(key)) {
    state.checkins.push(key);
    state.checkins.sort();
    persistNow();
    buildApp();
  }
}
function undoThisMonthPayment() {
  const key = currentMonthKey();
  if (Array.isArray(state.checkins)) {
    const i = state.checkins.indexOf(key);
    if (i >= 0) { state.checkins.splice(i, 1); persistNow(); buildApp(); }
  }
}

// ── The living ledger engine ────────────────────────────────────────────────
// Transient UI state: whether the log-payments panel is open, and the one-line
// "your target debt changed" note to show right after a log (never persisted).
let snowpackLogOpen = false;
let lastRerankNote = null;

// The debt Snowball is steering extra dollars at right now (top of the order).
function focusDebt(activeDebts, strategy) {
  if (!activeDebts.length) return null;
  const originalIndex = new Map(activeDebts.map((d, i) => [d.id, i]));
  const o = orderDebts(activeDebts, strategy, originalIndex);
  return o.length ? o[0] : null;
}
// A debt's APR right now — promo debts jump to their post-promo rate after the cliff.
function effectiveAprNow(debt) {
  if (debt.promo && debt.promo.endMonth && monthKeyNum(currentMonthKey()) > monthKeyNum(debt.promo.endMonth)) {
    return Math.max(0, safeNumber(debt.promo.postApr, { min: 0, max: MAX_APR }));
  }
  return Math.max(0, safeNumber(debt.apr, { min: 0, max: MAX_APR }));
}
// The plan's recommended payment for each active debt THIS month: every debt's
// minimum, with the whole extra stacked on the current focus debt. debtId -> $.
function recommendedThisMonth(activeDebts, strategy, extra) {
  const map = {};
  activeDebts.forEach((d) => { map[d.id] = Math.max(0, safeNumber(d.minPayment, { min: 0, max: MAX_MONEY })); });
  const f = focusDebt(activeDebts, strategy);
  if (f && extra > 0) map[f.id] = (map[f.id] || 0) + extra;
  return map;
}
// Apply a real month's payments: charge each debt one month's interest, subtract
// what was paid, rewrite its balance, and record ONE reversible ledger entry.
// Only touches debts present in `amountsById` (the ones the user was shown).
function applyMonthlyLog(month, amountsById) {
  const isActive = (d) => safeNumber(d.balance, { min: 0, max: MAX_MONEY }) > 0.005 && safeNumber(d.minPayment, { min: 0, max: MAX_MONEY }) > 0;
  const planActive = () => planScopedDebts().filter(isActive);
  const focusBefore = focusDebt(planActive(), state.strategy);
  const entries = [];
  let anyCleared = null;
  state.debts.forEach((d) => {
    if (!(d.id in amountsById)) return;
    const before = safeNumber(d.balance, { min: 0, max: MAX_MONEY });
    if (before <= 0.005) return;
    const paid = Math.max(0, safeNumber(amountsById[d.id], { min: 0, max: MAX_MONEY }));
    const interest = before * (effectiveAprNow(d) / 100 / 12);
    const after = Math.max(0, before + interest - paid);
    d.balance = after;
    if (before > 0.005 && after <= 0.005) anyCleared = (d.name || "").trim() || "a debt";
    entries.push({ debtId: d.id, paid, interest, before, after });
  });
  if (!entries.length) { snowpackLogOpen = false; buildApp(); return; }
  if (!Array.isArray(state.ledger)) state.ledger = [];
  state.ledger.push({ id: genId(), month, at: new Date().toISOString(), kind: "month", source: "", entries });
  if (!Array.isArray(state.checkins)) state.checkins = [];
  if (!state.checkins.includes(month)) { state.checkins.push(month); state.checkins.sort(); }

  // "Why your target changed" — recompute the focus on the NEW balances, honestly.
  const focusAfter = focusDebt(planActive(), state.strategy);
  if (focusBefore && focusAfter && focusBefore.id !== focusAfter.id) {
    const aName = (focusAfter.name || "").trim() || "your next debt";
    const bName = (focusBefore.name || "").trim() || "that debt";
    const beforeCleared = safeNumber(focusBefore.balance, { min: 0, max: MAX_MONEY }) <= 0.005;
    lastRerankNote = beforeCleared
      ? `🎉 ${bName} is paid off — My Snowball now steers your extra at ${aName}.`
      : `${aName} is now your ${state.strategy === "avalanche" ? "highest-rate debt" : "smallest balance"}, so My Snowball targets it next.`;
  } else if (anyCleared) {
    lastRerankNote = `🎉 You cleared ${anyCleared}!`;
  } else {
    lastRerankNote = null;
  }
  snowpackLogOpen = false;
  persistNow();
  buildApp();
}
// Reverse the most recent log: restore each debt's balance, drop the month's
// check-in if nothing else covers it. Only the latest entry is undoable, so the
// balance chain stays coherent.
function undoLastLog() {
  if (!Array.isArray(state.ledger) || !state.ledger.length) return;
  const last = state.ledger.pop();
  last.entries.forEach((e) => { const d = state.debts.find((x) => x.id === e.debtId); if (d) d.balance = safeNumber(e.before, { min: 0, max: MAX_MONEY }); });
  // Drop the month's check-in only if this was a monthly log and no other monthly
  // log still covers it (a snowflake never owns a check-in).
  if (Array.isArray(state.checkins) && last.kind !== "snowflake" && !state.ledger.some((l) => l.month === last.month && l.kind !== "snowflake")) {
    const i = state.checkins.indexOf(last.month);
    if (i >= 0) state.checkins.splice(i, 1);
  }
  lastRerankNote = null;
  persistNow();
  buildApp();
}

// ── Snowflakes — throw found money at the focus debt between check-ins ───────
// A snowflake is a one-off extra payment (rebate, cashback, sold something) that
// drops straight onto whichever debt the plan is steering at. It reduces that
// balance now (no monthly interest cycle — it's an extra, not a statement), lands
// in the ledger (reversible, shown in history), and re-projects the whole plan.
let snowflakeOpen = false;
function applySnowflake(amount, source) {
  const amt = Math.max(0, safeNumber(amount, { min: 0, max: MAX_MONEY }));
  if (amt <= 0) { snowflakeOpen = false; buildApp(); return; }
  const isActive = (d) => safeNumber(d.balance, { min: 0, max: MAX_MONEY }) > 0.005 && safeNumber(d.minPayment, { min: 0, max: MAX_MONEY }) > 0;
  const f = focusDebt(planScopedDebts().filter(isActive), state.strategy);
  const d = f && state.debts.find((x) => x.id === f.id);
  if (!d) { snowflakeOpen = false; buildApp(); return; }
  const before = safeNumber(d.balance, { min: 0, max: MAX_MONEY });
  const after = Math.max(0, before - amt);
  d.balance = after;
  if (!Array.isArray(state.ledger)) state.ledger = [];
  state.ledger.push({ id: genId(), month: currentMonthKey(), at: new Date().toISOString(), kind: "snowflake", source: (source || "").slice(0, 40), entries: [{ debtId: d.id, paid: amt, interest: 0, before, after }] });
  const name = (d.name || "").trim() || "your focus debt";
  lastRerankNote = after <= 0.005 ? `🎉 That snowflake cleared ${name}!` : `❄️ ${money(amt)} onto ${name} — every snowflake speeds you up.`;
  snowflakeOpen = false;
  persistNow();
  buildApp();
}

// The one motivating number that falls with every payment and snowflake: the
// total dollars left between here and debt-free, and how much of it is interest.
function buildTotalCostHero(active, plan) {
  if (!active || !active.length || !plan || plan.neverPaysOff || plan.months <= 0) return null;
  const remaining = active.reduce((s, d) => s + Math.max(0, safeNumber(d.balance, { min: 0, max: MAX_MONEY })), 0);
  const interest = Math.max(0, plan.totalInterest);
  const total = remaining + interest;
  if (total <= 0) return null;
  const card = el("div", "totalcost-hero");
  card.appendChild(txt("div", "totalcost-label", "From here to debt-free, you'll pay"));
  card.appendChild(txt("div", "totalcost-amount", money(total)));
  const sub = el("div", "totalcost-sub");
  sub.appendChild(document.createTextNode(`${money(remaining)} left on your balances + `));
  const b = el("b"); b.textContent = `${money(interest)} interest`; sub.appendChild(b);
  card.appendChild(sub);
  return card;
}
// The Snowpack "Undo" for the current month: reverse the real ledger log if this
// month has one, else just drop a legacy streak-only check-in.
function undoThisMonth() {
  const tm = currentMonthKey();
  if (Array.isArray(state.ledger) && state.ledger.length && state.ledger[state.ledger.length - 1].month === tm) undoLastLog();
  else undoThisMonthPayment();
}
let snowpackHistoryOpen = false;
function buildLedgerHistory() {
  const ledger = Array.isArray(state.ledger) ? state.ledger : [];
  if (!ledger.length) return null;
  const wrap = el("div", "snowpack-hist");
  const toggle = txt("button", "snowpack-hist-toggle", `${snowpackHistoryOpen ? "▾" : "▸"} Payment history (${ledger.length})`);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", snowpackHistoryOpen ? "true" : "false");
  toggle.onclick = () => { snowpackHistoryOpen = !snowpackHistoryOpen; buildApp(); };
  wrap.appendChild(toggle);
  if (snowpackHistoryOpen) {
    const list = el("div", "snowpack-hist-list");
    ledger.slice(-12).reverse().forEach((entry, idx) => {
      const paid = entry.entries.reduce((s, e) => s + safeNumber(e.paid, { min: 0, max: MAX_MONEY }), 0);
      const row = el("div", "snowpack-hist-row");
      if (entry.kind === "snowflake") {
        row.appendChild(txt("span", "snowpack-hist-month", entry.source ? `❄️ ${monthKeyLabel(entry.month)} · ${entry.source}` : `❄️ ${monthKeyLabel(entry.month)}`));
      } else {
        row.appendChild(txt("span", "snowpack-hist-month", monthKeyLabel(entry.month)));
      }
      const right = el("div", "snowpack-hist-right");
      if (entry.kind === "snowflake") {
        right.appendChild(txt("span", "snowpack-hist-amt", `${money(paid)} snowflake`));
      } else {
        const interest = entry.entries.reduce((s, e) => s + safeNumber(e.interest, { min: 0, max: MAX_MONEY }), 0);
        right.appendChild(txt("span", "snowpack-hist-amt", `${money(paid)} paid · ${money(interest)} interest`));
      }
      // Only the most-recent entry is reversible (keeps the balance chain coherent).
      if (idx === 0) {
        const undo = txt("button", "snowpack-hist-undo", "Undo"); undo.type = "button"; undo.onclick = undoLastLog;
        right.appendChild(undo);
      }
      row.appendChild(right);
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }
  return wrap;
}
// Conquered debts (The Shelf) — opt-in, private trophies for paid-off debts.
// Part of state → rides the backup vault; hard-sanitized so corrupt data can't crash.
function sanitizeClosedDebt(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : genId(),
    name: typeof raw.name === "string" ? raw.name : "",
    amount: safeNumber(raw.amount, { min: 0, max: MAX_MONEY }),
    freedPerMonth: safeNumber(raw.freedPerMonth, { min: 0, max: MAX_MONEY }),
    closedAt: (typeof raw.closedAt === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw.closedAt)) ? raw.closedAt : currentMonthKey(),
    note: typeof raw.note === "string" ? raw.note.slice(0, 280) : "",
  };
}
// Move a debt from the active list onto The Shelf as a conquered trophy.
function markDebtPaidOff(i) {
  const d = state.debts[i];
  if (!d) return;
  if (!Array.isArray(state.closedDebts)) state.closedDebts = [];
  state.closedDebts.push({
    id: d.id || genId(),
    name: (d.name || "").trim(),
    amount: Math.max(0, safeNumber(d.balance, { min: 0, max: MAX_MONEY })),
    freedPerMonth: Math.max(0, safeNumber(d.minPayment, { min: 0, max: MAX_MONEY })),
    closedAt: currentMonthKey(),
    note: "",
  });
  state.debts.splice(i, 1);
  if (state.debts.length === 0) state.debts.push({ id: genId(), name: "", balance: 0, apr: 0, minPayment: 0 });
  persistNow();
  buildApp();
}
function removeFromShelf(id) {
  if (!Array.isArray(state.closedDebts)) return;
  const i = state.closedDebts.findIndex((c) => c.id === id);
  if (i >= 0) { state.closedDebts.splice(i, 1); persistNow(); buildApp(); }
}
function sanitizeState(raw) {
  const fallback = blankState();
  if (!raw || typeof raw !== "object") return fallback;
  const cleanedDebts = Array.isArray(raw.debts) ? raw.debts.map(sanitizeDebt).filter(Boolean) : [];
  return {
    strategy: (raw.strategy === "avalanche" || raw.strategy === "custom") ? raw.strategy : "snowball",
    extraPayment: safeNumber(raw.extraPayment, { min: 0, max: MAX_MONEY }),
    customOrder: sanitizeCustomOrder(raw.customOrder),
    debts: cleanedDebts.length ? cleanedDebts : fallback.debts,
    checkins: sanitizeCheckins(raw.checkins),
    closedDebts: Array.isArray(raw.closedDebts) ? raw.closedDebts.map(sanitizeClosedDebt).filter(Boolean).slice(0, 500) : [],
    ledger: sanitizeLedger(raw.ledger),
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    return sanitizeState(JSON.parse(raw));
  } catch { return blankState(); }
}
let state = loadState();
let lastSaveError = null;
let saveTimer = null;
function persistNow() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); lastSaveError = null; showAutosaveNote(true); }
  catch (e) { lastSaveError = e; showAutosaveNote(false); }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persistNow, 400); }
// A pending debounced save is the only copy of the user's last edit —
// flush it immediately if the tab is closed, backgrounded, or reloaded
// before the 400ms debounce fires, instead of silently losing it.
function flushPendingSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; persistNow(); } }
window.addEventListener("pagehide", flushPendingSave);
window.addEventListener("beforeunload", flushPendingSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPendingSave(); });
function showAutosaveNote(ok) {
  const note = $("#autosaveNote");
  if (!note) return;
  note.textContent = ok ? "Saved automatically to this device." : friendly(lastSaveError);
  note.style.color = ok ? "" : "var(--danger)";
}
function friendly(e) {
  if (e && e.name === "QuotaExceededError") return "Couldn't save — your browser's local storage is full.";
  if (e && e.name) return "Couldn't save — local storage is blocked (this can happen in private browsing).";
  return "Couldn't save right now. Your changes are still on this screen.";
}

// ── Payoff simulation (pure math, no DOM) ──────────────────────────────
// Orders OPEN debts by strategy: snowball = smallest balance first,
// avalanche = highest APR first. Ties break by original entry order so
// results are deterministic and reproducible.
function orderDebts(open, strategy, originalIndex) {
  const withIdx = open.map((d) => ({ d, idx: originalIndex.get(d.id) }));
  if (strategy === "custom") {
    // The user's chosen order; any debt not yet placed falls to the end by index.
    const pos = new Map((Array.isArray(state.customOrder) ? state.customOrder : []).map((id, i) => [id, i]));
    withIdx.sort((a, b) => {
      const pa = pos.has(a.d.id) ? pos.get(a.d.id) : 1e9 + a.idx;
      const pb = pos.has(b.d.id) ? pos.get(b.d.id) : 1e9 + b.idx;
      return pa - pb;
    });
    return withIdx.map((x) => x.d);
  }
  withIdx.sort((a, b) => {
    if (strategy === "avalanche") {
      if (b.d.apr !== a.d.apr) return b.d.apr - a.d.apr;
      if (b.d.balance !== a.d.balance) return b.d.balance - a.d.balance;
    } else {
      if (a.d.balance !== b.d.balance) return a.d.balance - b.d.balance;
    }
    return a.idx - b.idx;
  });
  return withIdx.map((x) => x.d);
}

// ── Free-tier plan scope ──────────────────────────────────────────────────
// The free tier plans the first FREE_DEBT_LIMIT debts. The "+ Add debt" button
// caps a free user at that many, but a backup imported via Restore-from-backup
// can carry more — so the PLAN itself (every simulation input and the summary
// totals) is scoped HERE, not only at the add button. Extra debts stay in state
// and remain visible, but are excluded from the free plan and shown locked with
// an upsell, so the advertised "plan every debt" Pro value can't be obtained for
// free. Owners (isPro) always plan every debt.
const FREE_DEBT_LIMIT = 4;
function planScopedDebts() {
  let pro = false;
  try { pro = Billing.isPro(); } catch (e) { pro = false; }
  return pro ? state.debts : state.debts.slice(0, FREE_DEBT_LIMIT);
}

// Simulates one strategy against a FIXED total monthly budget (sum of every
// debt's minimum payment + any extra). Every open debt always gets at least
// its own minimum; whatever's left over (the extra payment, plus the
// minimums of debts that have already been paid off) rolls onto the
// highest-priority still-open debt each month. Capped at CAP_MONTHS so a
// budget that can't cover total interest can never hang the loop — it
// reports `neverPaysOff: true` instead.
// A debt's required minimum THIS month, given its current balance + the interest
// just charged. Fixed debts return their flat minimum (unchanged behavior).
// Percent debts return (minPercent% of balance + interest), floored at the entered
// minPayment (or $25) — so it always covers interest and shrinks as the balance
// falls, exactly like a real credit-card minimum.
function debtMinThisMonth(d, balance) {
  if (d.minKind === "percent") {
    const pct = Math.max(0, safeNumber(d.minPercent, { min: 0, max: 100 }));
    // A % of the current balance, floored at a typical $25 card minimum — so it
    // shrinks as the balance falls (paying less over time = the real trap).
    return Math.max(25, (pct / 100) * Math.max(0, balance));
  }
  return Math.max(0, safeNumber(d.minPayment, { min: 0, max: MAX_MONEY }));
}
function simulateStrategy(debts, strategy, extraPayment, opts = {}) {
  const nowNum = monthKeyNum(currentMonthKey());
  const active = debts.filter((d) => d.balance > 0.005).map((d) => {
    const c = { ...d };
    // Precompute the promo cliff (sim-months from now until the rate jumps).
    c._cliff = (d.promo && d.promo.endMonth) ? (monthKeyNum(d.promo.endMonth) - nowNum) : null;
    // Deferred-interest promos: interest secretly accrues at the go-to rate during
    // the 0% window and is back-charged IN FULL if any balance remains at the cliff.
    c._deferred = !!(d.promo && d.promo.deferred && c._cliff != null && c._cliff > 0);
    c._deferredAccrued = 0;
    c._deferredCharged = false;
    return c;
  });
  const originalIndex = new Map(active.map((d, i) => [d.id, i]));
  // Budget = extra + each debt's STARTING minimum (fixed debts: their flat min,
  // unchanged; percent debts: their initial computed min). Held constant so the
  // snowball still rolls; percent debts' shrinking min just frees more for rollover.
  const totalMonthlyBudget = extraPayment + active.reduce((s, d) => s + debtMinThisMonth(d, d.balance, d.balance * (Math.max(0, d.apr) / 100 / 12)), 0);
  const totalStartBalance = active.reduce((s, d) => s + d.balance, 0);

  // Optional per-debt balance-over-time series (for the Cascade animation).
  const series = opts.trackPerDebt ? {} : null;
  const startById = opts.trackPerDebt ? {} : null;
  if (opts.trackPerDebt) active.forEach((d) => { series[d.id] = [Math.max(0, d.balance)]; startById[d.id] = Math.max(0, d.balance); });

  const payoffMonth = {};
  const snapshots = [{ month: 0, totalBalance: totalStartBalance }];
  let totalInterest = 0;
  let month = 0;

  if (!active.length) return { months: 0, neverPaysOff: false, totalInterest: 0, payoffMonth, snapshots, totalStartBalance: 0 };

  while (active.some((d) => d.balance > 0.005) && month < CAP_MONTHS) {
    month++;
    // Deferred-interest bomb: the first month past the cliff, any remaining balance
    // triggers ALL the interest waived during the promo, added at once. Cleared in
    // time (balance already 0) → it's forgiven, the whole point of beating the cliff.
    active.forEach((d) => {
      if (d._deferred && !d._deferredCharged && d._cliff != null && month === d._cliff + 1) {
        if (d.balance > 0.005) { d.balance += d._deferredAccrued; totalInterest += d._deferredAccrued; }
        d._deferredCharged = true;
      }
    });
    active.forEach((d) => {
      d._lastInt = 0;
      if (d.balance > 0.005) {
        // Promo debts jump to the post-promo rate once the cliff month passes.
        const pastCliff = (d._cliff != null && month > d._cliff);
        const rate = pastCliff ? Math.max(0, (d.promo && d.promo.postApr) || 0) : d.apr;
        const interest = d.balance * (Math.max(0, rate) / 100 / 12);
        d.balance += interest;
        d._lastInt = interest;
        totalInterest += interest;
        // During the 0% window, shadow-accrue what a deferred offer will back-charge.
        if (d._deferred && !pastCliff) {
          d._deferredAccrued += d.balance * (Math.max(0, (d.promo && d.promo.postApr) || 0) / 100 / 12);
        }
      }
    });

    if (opts.minimumsOnly) {
      // Minimums-only truth (the trap): pay each debt exactly its current minimum,
      // which SHRINKS for percent debts — no held-constant total, no rollover.
      active.forEach((d) => {
        if (d.balance > 0.005) {
          const pay = Math.min(debtMinThisMonth(d, d.balance, d._lastInt), d.balance);
          d.balance -= pay;
        }
      });
    } else {
      // A tight-month override lets month 1 use a reduced budget (Rough-Month
      // Triage); every other month uses the normal budget. Default: unchanged.
      let remaining = (opts.firstMonthBudget != null && month === 1)
        ? Math.max(0, opts.firstMonthBudget)
        : totalMonthlyBudget;
      active.forEach((d) => {
        if (d.balance > 0.005) {
          const pay = Math.min(debtMinThisMonth(d, d.balance, d._lastInt), d.balance, Math.max(0, remaining));
          d.balance -= pay;
          remaining -= pay;
        }
      });

      const order = orderDebts(active.filter((d) => d.balance > 0.005), strategy, originalIndex);
      for (const d of order) {
        if (remaining <= 0) break;
        const pay = Math.min(remaining, d.balance);
        d.balance -= pay;
        remaining -= pay;
      }
    }

    active.forEach((d) => {
      if (d.balance <= 0.005 && !(d.id in payoffMonth)) payoffMonth[d.id] = month;
    });
    snapshots.push({ month, totalBalance: active.reduce((s, d) => s + Math.max(0, d.balance), 0) });
    if (opts.trackPerDebt) active.forEach((d) => series[d.id].push(Math.max(0, d.balance)));
  }

  return {
    months: month,
    neverPaysOff: active.some((d) => d.balance > 0.005),
    totalInterest,
    payoffMonth,
    snapshots,
    totalStartBalance,
    ...(opts.trackPerDebt ? { series, startById } : {}),
  };
}

// ── Goal-seek: "be debt-free by [date]" ────────────────────────────────
// Binary-searches the smallest EXTRA monthly payment (on top of every debt's
// minimum) that pays all debts off within `targetMonths` months, using the
// same pure simulateStrategy() the results panel uses. Returns one of:
//   { kind: "already" }                 — $0 extra already meets the goal
//   { kind: "found", extra }            — about `extra`/mo extra is needed
//   { kind: "unreachable", cap }        — even `cap`/mo extra can't hit it
// `cap` is a sane upper bound on the search (default: 10× the total minimums,
// with a floor so tiny-minimum debts still get a meaningful ceiling).
const GOAL_SEEK_ITERATIONS = 40; // 40 halvings of the cap resolve to sub-cent precision
function goalSeekExtra(debts, strategy, targetMonths, opts = {}) {
  const active = debts.filter((d) => d.balance > 0 && d.minPayment > 0);
  if (!active.length || !Number.isFinite(targetMonths) || targetMonths < 1) return null;

  const totalMin = active.reduce((s, d) => s + d.minPayment, 0);
  const cap = Math.min(MAX_MONEY, Math.max(opts.cap || 0, totalMin * 10, 1000));

  const meets = (extra) => {
    const r = simulateStrategy(active, strategy, extra);
    return !r.neverPaysOff && r.months <= targetMonths;
  };

  // $0 extra already gets there — nothing more is needed.
  if (meets(0)) return { kind: "already" };
  // Even the ceiling can't reach the goal (e.g. a minimum below interest that
  // extra alone routed elsewhere can't rescue, or a wildly early target).
  if (!meets(cap)) return { kind: "unreachable", cap };

  // Binary search the boundary between "misses" (lo) and "meets" (hi).
  let lo = 0, hi = cap;
  for (let i = 0; i < GOAL_SEEK_ITERATIONS && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (meets(mid)) hi = mid; else lo = mid;
  }
  // hi is the smallest tested extra that meets the goal; round up to whole
  // dollars so the surfaced figure is safely sufficient, never a cent short.
  return { kind: "found", extra: Math.ceil(hi) };
}

// Parses the month input's YYYY-MM value into a whole number of months from
// now (end of the target month). Returns null for empty/invalid input.
function targetMonthsFromValue(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const year = parseInt(m[1], 10), month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  const now = new Date();
  // Whole months between the current month and the target month. `month` is
  // 1-indexed (from the YYYY-MM value) while now.getMonth() is 0-indexed, so
  // subtract 1 from `month` to align them. "This month" → 0, "next month" → 1,
  // exactly one year out → 12. The run()/goalSeekExtra guards reject anything
  // below 1 (you can't be debt-free within the current month from a plan that
  // starts today), so a target this month or earlier is handled there.
  const months = (year - now.getFullYear()) * 12 + (month - 1 - now.getMonth());
  return months;
}

// ── Editor rendering ─────────────────────────────────────────────────────
let fieldIdSeq = 0;
function field(label, value, onChange, opts = {}) {
  const wrap = el("div", "field");
  const id = `f${++fieldIdSeq}`;
  const labelEl = txt("label", "field-label", label);
  labelEl.htmlFor = id;
  wrap.appendChild(labelEl);
  const input = el("input");
  input.id = id;
  input.type = opts.numeric ? "text" : "text";
  input.inputMode = opts.numeric ? "decimal" : undefined;
  input.placeholder = opts.placeholder || "";
  input.value = value === "" || value == null ? "" : String(value);
  input.addEventListener("input", () => onChange(input.value));
  // On blur, snap a numeric field's displayed text to the same clamped value
  // the model stored, so a typed-then-clamped entry (e.g. "-500" → 0, or an
  // over-cap amount) never keeps showing a figure the plan isn't actually
  // using. An empty field stays empty so the placeholder still shows.
  if (opts.numeric) {
    input.addEventListener("blur", () => {
      if (input.value.trim() === "") return;
      const clamped = safeNumber(input.value, { min: opts.min ?? 0, max: opts.max ?? MAX_MONEY });
      const shown = String(clamped);
      if (input.value !== shown) { input.value = shown; onChange(input.value); }
    });
  }
  wrap.appendChild(input);
  return wrap;
}

// ── Pro license card (loss-proofing the restore code) ───────────────────
function markCodeAcknowledged() {
  try { localStorage.setItem(CODE_ACK_KEY, "1"); } catch { /* private-browsing lockout — the nag just reappears next visit */ }
  const nag = $("#saveNagBanner");
  if (nag) nag.remove();
}

function licenseDownloadButton(canvas) {
  const LABEL = "Download card (PNG)";
  const btn = txt("button", "btn ghost", LABEL); btn.type = "button";
  const filename = "snowball-pro-license.png";
  const flash = (msg) => { btn.textContent = msg; setTimeout(() => { btn.textContent = LABEL; }, 3500); };
  btn.onclick = async () => {
    try {
      // Build the PNG SYNCHRONOUSLY inside the click gesture. The old code fired the
      // save from an async canvas.toBlob callback, which runs after the handler
      // returns — outside the user-activation window — so Safari/WebKit (macOS Safari
      // AND the iOS WKWebView) silently dropped it. toDataURL stays inside the gesture.
      const dataUrl = canvas.toDataURL("image/png");

      // Native app shell (iOS/Android Capacitor): WKWebView ignores <a download>, so
      // save through the OS share sheet like downloadPdfBytes does.
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
        const { Filesystem, Share } = window.Capacitor.Plugins;
        const { uri } = await Filesystem.writeFile({ path: filename, data: dataUrl.split(",")[1], directory: "CACHE" });
        await Share.share({ title: filename, files: [uri] });
        flash("Saved!");
        return;
      }

      // Mobile web — iOS Safari won't honor <a download> for an image (it opens a
      // preview instead of saving), so offer the native share sheet's "Save Image".
      // Build the File synchronously and invoke share before any await, to keep the
      // user-activation window alive. Mirrors shareMilestoneCard's working path.
      // Gated to mobile so desktop still gets a clean direct download, not a share sheet.
      const isMobile = /iP(hone|ad|od)|Android/i.test(navigator.userAgent || "");
      if (isMobile && navigator.canShare && navigator.share) {
        const bin = atob(dataUrl.split(",")[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], filename, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "My Snowball Pro card" });
          flash("Saved.");
          return;
        }
      }

      // Desktop web (and any browser without file sharing): a straight download works.
      const a = document.createElement("a");
      a.href = dataUrl; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      flash("Saved to your downloads");
    } catch (e) {
      // A cancelled share sheet isn't a failure — just reset the label.
      if (e && (e.name === "AbortError" || e.name === "NotAllowedError")) { btn.textContent = LABEL; return; }
      flash("Couldn't save — try again");
    }
  };
  return btn;
}

function copyCodeButton(code) {
  const btn = txt("button", "btn ghost", "Copy code"); btn.type = "button";
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); btn.textContent = "Copied!"; }
    catch { btn.textContent = "Couldn't copy — select it manually"; }
    setTimeout(() => { btn.textContent = "Copy code"; }, 2000);
  };
  return btn;
}

function showLicenseCardModal() {
  // No license card or typed code on iOS — every entry point is already native-gated
  // (save-nag, footer link, settings card), and Apple restore covers cross-device. This
  // guard retires the last latent native branch so no code surface can ever open on iOS.
  if (IS_NATIVE) return;
  const code = Billing.getRestoreCode();
  if (!code) { showRestoreEntryModal(); return; }
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  modal.appendChild(txt("h3", null, "Your Pro license card"));
  modal.appendChild(txt("p", "hint", "Download it, print it, or screenshot it — this card is your key back into Pro in any browser. Keep your receipt email too as proof of purchase; questions? support@mysnowballapp.com."));
  const canvas = Billing.renderLicenseCard(code, "My Snowball");
  canvas.className = "license-card-canvas";
  modal.appendChild(canvas);
  const savedBtn = txt("button", "btn big", "I've saved it"); savedBtn.type = "button";
  savedBtn.onclick = () => { markCodeAcknowledged(); backdrop.remove(); };
  const actions = el("div", "pro-actions license-actions");
  actions.append(licenseDownloadButton(canvas), copyCodeButton(code), savedBtn);
  modal.appendChild(actions);
  // Quiet "Need a refund?" entry for owners — request-only, opens a pre-filled
  // email to support (no refund is ever executed by the app). Web only — on iOS,
  // Apple owns IAP refunds (Report a Problem), so this self-run entry is suppressed.
  if (!IS_NATIVE) modal.appendChild(buildRefundBlock());
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

// Boot-time reminder shown until the user explicitly confirms ("I've saved
// it") that the license card is somewhere safe. The × only hides it for
// this page load — deliberately, since an unsaved code is a ticking loss.
function maybeShowSaveNag() {
  if (IS_NATIVE) return; // iOS has no restore CODE / license card to save — Apple restore covers cross-device
  if (!Billing.getRestoreCode()) return;
  // Only nag to "save your Pro license card" when this browser is ACTUALLY Pro.
  // A stored code alone isn't enough: a refunded/expired/hollow code leaves a
  // stale code in localStorage, and showing "Keep Pro safe" next to the Unlock-Pro
  // paywall reads as "the app thinks I'm Pro but won't unlock." isPro() is a
  // synchronous read of the last verified check, so this is re-evaluated after the
  // boot refreshProStatus() (and every refreshAfterProChange) — an offline owner
  // still fails OPEN and keeps the nag.
  let pro = false; try { pro = Billing.isPro(); } catch (e) { pro = false; }
  if (!pro) return;
  let ack = null;
  try { ack = localStorage.getItem(CODE_ACK_KEY); } catch { /* treat as unacknowledged */ }
  if (ack === "1" || $("#saveNagBanner")) return;
  const bar = el("div", "save-nag"); bar.id = "saveNagBanner";
  bar.appendChild(txt("span", "save-nag-text", "Keep Pro safe — save your license card so you can restore it anytime."));
  const view = txt("button", "btn sm save-nag-view", "View card"); view.type = "button";
  view.onclick = () => showLicenseCardModal();
  bar.appendChild(view);
  const close = txt("button", "save-nag-close", "×"); close.type = "button";
  close.setAttribute("aria-label", "Dismiss for now");
  close.onclick = () => bar.remove();
  bar.appendChild(close);
  document.body.insertBefore(bar, document.body.firstChild);
}

// Self-heal banner: this browser owns Pro but has no restore code (mint failed
// after purchase, or the tab closed before it ran). Offers to create the code
// so the owner can unlock other devices. Uses the same slim banner slot as the
// save-your-card nag. Reuses #saveNagBanner id, so only one banner shows at a
// time (an owner with a code sees the save-card nag; an owner without one sees
// this). On success it opens the normal save-code modal.
function maybeShowSelfHealNag() {
  if (IS_NATIVE) return; // iOS mints no restore code — cross-device restore is via the Apple ID
  let isPro = false;
  try { isPro = Billing.isPro(); } catch (e) { isPro = false; }
  if (!isPro) return;
  if (Billing.getRestoreCode()) return; // has a code — the save-card nag covers it
  if ($("#saveNagBanner")) return;
  const bar = el("div", "save-nag"); bar.id = "saveNagBanner";
  bar.appendChild(txt("span", "save-nag-text", "You're Pro on this browser — create your restore code so you can unlock other devices too."));
  const make = txt("button", "btn sm save-nag-view", "Create code"); make.type = "button";
  make.onclick = async () => {
    make.disabled = true; make.textContent = "Creating…";
    let res;
    try { res = await Billing.mintRestoreCode(); }
    catch (e) { res = { ok: false, restoreCode: null }; }
    if (res && res.ok && res.restoreCode) {
      bar.remove();
      updateLicenseFooterLink();
      showRestoreCodeModal(res.restoreCode);
    } else {
      make.disabled = false; make.textContent = "Create code";
      announce("No luck yet — Pro still works here; we'll offer again next visit, and " + SUPPORT_EMAIL + " + your receipt always work.", false);
    }
  };
  bar.appendChild(make);
  const close = txt("button", "save-nag-close", "×"); close.type = "button";
  close.setAttribute("aria-label", "Dismiss for now");
  close.onclick = () => bar.remove();
  bar.appendChild(close);
  document.body.insertBefore(bar, document.body.firstChild);
}

function updateLicenseFooterLink() {
  const link = $("#footerLicenseLink");
  if (IS_NATIVE) { if (link) link.hidden = true; return; } // iOS mints no restore code / license card — Apple restore covers it
  if (link) {
    // Only offer the license card on a browser that's ACTUALLY Pro — a refunded / hollow-code
    // browser shouldn't be pointed at a "your key back into Pro" card for a dead code. isPro()
    // is re-evaluated via refreshAfterProChange after the boot check (offline owners fail OPEN).
    let pro = false; try { pro = Billing.isPro(); } catch (e) { pro = false; }
    link.hidden = !(Billing.getRestoreCode() && pro);
  }
}

// The sidebar "Unlock Pro" card is a quiet front door to the existing paywall.
// It's HIDDEN for owners (isPro) — an owner never sees the upsell again — and
// re-evaluated after any Pro-status change via refreshAfterProChange(). If
// isPro() throws we treat it as not-Pro (show the card) but never let it throw.
// The card is a real <button>, so click + Enter/Space open the paywall for free.
function updateSideProCard() {
  const card = $("#sideProCard");
  if (!card) return;
  let isPro = false;
  try { isPro = Billing.isPro(); } catch (e) { isPro = false; }
  card.hidden = isPro;
  if (!isPro && !card.dataset.wired) {
    card.dataset.wired = "1";
    card.addEventListener("click", () => showProModal({ reason: "sidebar" }));
  }
  // iOS: the card's "$9.99 · one-time" is static HTML — swap in Apple's localized
  // price so the first number a buyer sees matches Apple's payment sheet. (No-ops
  // on web, and keeps the hardcoded price until the fetch lands.)
  if (!isPro && IS_NATIVE) { ensureNativePrice(); refreshNativePriceLabels(); }
}

// The footer "Need a refund?" entry is shown to owners (isPro), so an ex-owner
// after access-stop no longer sees it (refreshAfterProChange re-runs this).
function updateRefundFooterLink() {
  const link = $("#footerRefundLink");
  if (!link) return;
  if (IS_NATIVE) { link.hidden = true; return; } // Apple owns refunds for IAP (Report a Problem) — no self-run refund entry on iOS
  let isPro = false;
  try { isPro = Billing.isPro(); } catch (e) { isPro = false; }
  link.hidden = !isPro;
}

// Opens a small modal with the refund expectations + a pre-filled mailto entry.
// Request-only: it never calls any refund/charge API. Reuses the refund block.
function showRefundModal() {
  if (IS_NATIVE) return; // Apple owns refunds for IAP — support.html's only-ios card points to reportaproblem.apple.com
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.appendChild(txt("h3", null, "Need a refund?"));
  modal.appendChild(buildRefundBlock());
  const a11y = makeModalAccessible(backdrop, modal, { escCloses: true });
  const closeBtn = txt("button", "btn ghost", "Close"); closeBtn.type = "button";
  closeBtn.onclick = () => a11y.close();
  const actions = el("div", "pro-actions"); actions.append(closeBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) a11y.close(); });
  document.body.appendChild(backdrop);
}

function showRestoreCodeModal(code) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  modal.appendChild(txt("h3", null, "You're Pro — here's your restore code"));
  modal.appendChild(txt("p", "hint", "My Snowball keeps no accounts, so this code is your key to unlock Pro in another browser — on your phone or computer. Save it somewhere safe and you're all set."));
  modal.appendChild(txt("p", "hint", "Keep your receipt email too — it's your proof of purchase. Questions? support@mysnowballapp.com."));
  const codeBox = el("div", "restore-code-box");
  const codeText = txt("code", "restore-code-value", code || "—");
  codeBox.appendChild(codeText);
  const copyBtn = txt("button", "btn ghost sm", "Copy"); copyBtn.type = "button";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
    catch { copyBtn.textContent = "Couldn't copy — select and copy manually"; }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  };
  codeBox.appendChild(copyBtn);
  modal.appendChild(codeBox);
  const actions = el("div", "pro-actions license-actions");
  if (code) {
    const canvas = Billing.renderLicenseCard(code, "My Snowball");
    canvas.className = "license-card-canvas";
    modal.appendChild(canvas);
    actions.appendChild(licenseDownloadButton(canvas));
  }
  const doneBtn = txt("button", "btn big", "I've saved it"); doneBtn.type = "button";
  // Escape can't dismiss this (escCloses:false) — the code is the only key back
  // into Pro, so it shouldn't be closeable before it's saved.
  const a11y = makeModalAccessible(backdrop, modal, { escCloses: false });
  doneBtn.onclick = () => { markCodeAcknowledged(); a11y.close(); refreshAfterProChange(); runPendingProIntent(); };
  actions.appendChild(doneBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

// Single-shot restore-code normalizer: uppercase, strip junk, peel ONE leading
// SNOW prefix, and regroup as SNOW-XXXX-XXXX-XXXX. Runs ONCE, at submit — never
// live while typing. A live regrouper that injects the prefix creates a feedback
// loop that absorbs a hand-typed S-N-O-W into the code body ("SNOW-SNOW-…", an
// identity that unlocks nothing) — the exact owner-lockout Local PDF already hit
// and fixed; this mirrors its proven normalize-at-submit pattern.
function formatRestoreCodeInput(raw) {
  const val = String(raw || "");
  // Leave a raw account id untouched — a legacy "snow_…" id or an RC
  // "$RCAnonymousID:…" fallback code (what mintRestoreCode hands back when it
  // can't alias onto a pretty code). Those are case-sensitive, and their marker
  // chars never appear in a real minted code.
  if (/[_$]/.test(val)) return val.trim();
  let s = val.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // A valid code body can NEVER contain "SNOW" (the O isn't in the code alphabet), so any
  // "SNOW" is a prefix marker — take everything after the LAST one. Strips a doubled
  // "SNOW-SNOW-…" AND a leading label like "Code: SNOW-…" that survived char-stripping.
  const pi = s.lastIndexOf("SNOW");
  if (pi >= 0) s = s.slice(pi + 4);
  // Body chars come only from billing's unambiguous CODE_ALPHABET (no 0/O/1/I/L),
  // so stray lookalikes and junk are dropped rather than corrupting the identity.
  const body = s.replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, "").slice(0, 12);
  const groups = body.match(/.{1,4}/g) || [];
  return groups.length ? "SNOW-" + groups.join("-") : "";
}
// Live handler: ONLY uppercase in place (non-destructive, caret kept) so the
// field always shows exactly what was typed. All regrouping happens at submit.
function wireRestoreCodeInput(input) {
  input.addEventListener("input", () => {
    const val = input.value;
    if (/[_$]/.test(val)) return; // case-sensitive raw ids ($RCAnonymousID / legacy snow_) stay exactly as pasted
    const up = val.toUpperCase();
    if (up !== val) {
      const pos = input.selectionStart;
      input.value = up;
      try { input.setSelectionRange(pos, pos); } catch (e) {}
    }
  });
}

function showRestoreEntryModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.appendChild(txt("h3", null, "Restore Pro"));
  modal.appendChild(txt("p", "hint", "Enter the restore code you saved when you unlocked Pro."));
  const input = document.createElement("input");
  input.type = "text"; input.placeholder = "SNOW-XXXX-XXXX-XXXX"; input.className = "restore-code-input";
  input.autocapitalize = "characters"; input.autocomplete = "off"; input.spellcheck = false;
  input.setAttribute("aria-label", "Restore code");
  wireRestoreCodeInput(input);
  modal.appendChild(input);
  // Lost-code fallback, right where the code is asked for — the answer used to
  // live only on support.html, which this modal never pointed at.
  modal.appendChild(txt("p", "hint", "Lost your code? Email " + SUPPORT_EMAIL + " and we'll help."));
  const msgHost = el("div", "pro-msg");
  const a11y = makeModalAccessible(backdrop, modal, { escCloses: true });
  const goBtn = txt("button", "btn big", "Restore"); goBtn.type = "button";
  goBtn.onclick = async () => {
    goBtn.disabled = true; goBtn.textContent = "Checking…";
    let res;
    try { res = await Billing.restoreWithCode(formatRestoreCodeInput(input.value)); }
    catch (e) { res = { ok: false, error: "Couldn't restore — try again." }; }
    if (res && res.ok) {
      a11y.close();
      announce("Welcome back — Pro is unlocked on this device.", false);
      showToast("Welcome back — Pro is unlocked on this device.");
      refreshAfterProChange();
      runPendingProIntent();
    } else {
      goBtn.disabled = false; goBtn.textContent = "Restore";
      msgHost.innerHTML = "";
      const errText = (res && res.offline)
        ? "You're offline — restoring Pro needs a connection to verify your code. Everything else works offline."
        : ((res && res.error) || "Couldn't restore — try again.");
      announce(errText, true);
      const s = el("div", "status-msg err");
      s.appendChild(document.createTextNode(errText));
      msgHost.appendChild(s);
    }
  };
  const closeBtn = txt("button", "btn ghost", "Cancel"); closeBtn.type = "button";
  closeBtn.onclick = () => a11y.close();
  const actions = el("div", "pro-actions"); actions.append(goBtn, closeBtn);
  modal.append(actions, msgHost);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) a11y.close(); });
  document.body.appendChild(backdrop);
}

// ── Toast (brief, self-dismissing corner note) ────────────────────────────
// For lightweight success feedback (restore succeeded) where a full modal is
// too heavy. The aria-live announce() is done by callers; this is the visual.
let _toastTimer = null;
function showToast(message, actionLabel, onAction) {
  let host = $("#snowToast");
  if (!host) {
    host = el("div", "snow-toast"); host.id = "snowToast";
    host.setAttribute("aria-hidden", "true"); // announce() already covers AT
    document.body.appendChild(host);
  }
  host.textContent = String(message || "");
  // Optional inline action (e.g. "Undo") — a plain underlined button in the toast's own colour.
  if (actionLabel && typeof onAction === "function") {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = String(actionLabel);
    btn.style.cssText = "margin-left:14px;background:none;border:0;color:inherit;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer;padding:0";
    btn.onclick = () => { clearTimeout(_toastTimer); host.classList.remove("show"); onAction(); };
    host.appendChild(btn);
  }
  host.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { host.classList.remove("show"); }, 4200);
}

// ── Pending gated intent ────────────────────────────────────────────────
// When a gate opens the paywall, we remember what the user was trying to do so
// a successful unlock/restore resumes it automatically instead of dropping them
// back to hunt for the button. Store a single closure; it's cleared after one run.
let pendingProIntent = null;
function setPendingProIntent(fn) { pendingProIntent = typeof fn === "function" ? fn : null; }
function runPendingProIntent() {
  const fn = pendingProIntent;
  pendingProIntent = null;
  if (!fn) return;
  // A failed intent must never break the unlock celebration around it.
  try { fn(); } catch (e) { /* the button that set it is still on-screen to retry */ }
}

// Gate a Pro-only action behind a live entitlement check. While the check runs,
// the triggering button is disabled and shows "Checking…" (guarding double-
// clicks). If Pro, `action()` runs. Otherwise the paywall opens with `action`
// stored as the pending intent so a successful unlock/restore resumes it.
// `context` is passed through to showProModal for the personalized lead-in.
// A brand-new visitor never triggers a network call here (shouldCheckAtBoot is
// only consulted at boot); this on-demand check is exactly the "engaged a Pro
// action" moment the app's on-device promise allows a network touch.
async function gateProAction(btn, context, action) {
  if (btn && btn.disabled) return; // double-click guard
  // Fast path: already known Pro this session — no spinner, no network.
  if (Billing.isPro()) { action(); return; }
  const restoreLabel = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.dataset.gateLabel = restoreLabel; btn.textContent = "Checking…"; }
  let pro = false;
  try { pro = await Billing.refreshProStatus(); } catch (e) { pro = Billing.isPro(); }
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.gateLabel || restoreLabel; delete btn.dataset.gateLabel; }
  if (pro) { markWasProIfActive(); refreshAfterProChange(); action(); return; }
  // Not Pro. If this browser WAS a verified owner, this is a real revocation
  // (refund/expiry) — handle it kindly + non-destructively before the paywall.
  handleAccessStopIfRevoked();
  setPendingProIntent(action);
  showProModal(context);
}

// ── Access-stop (Pro revoked / refunded) ─────────────────────────────────
// Records that this browser is currently a verified owner, so a LATER verified
// flip to not-Pro can be recognized as a real revocation rather than a first
// visit. Only call this when isPro() is genuinely true (after a refresh).
function markWasProIfActive() {
  try {
    if (Billing.isPro()) localStorage.setItem(WAS_PRO_KEY, "1");
  } catch (e) { /* private-browsing lockout — access-stop just won't fire, harmless */ }
}
function wasPro() {
  try { return localStorage.getItem(WAS_PRO_KEY) === "1"; } catch { return false; }
}
function clearWasPro() {
  try { localStorage.setItem(WAS_PRO_KEY, "0"); } catch { /* ignore */ }
}

// Call AFTER any verified refreshProStatus() (boot + gate checks). If this
// browser was a known owner (was_pro === "1") but isPro() is now false, that's a
// genuine, server-verified revocation (refund or expiry) — handle it kindly,
// exactly once, and NON-DESTRUCTIVELY. Because refreshProStatus() fails OPEN for
// known owners offline, an offline blip keeps isPro()===true and never reaches
// here, so we never guess a revocation from a network hiccup.
//
// IMPORTANT: this touches NO user data. It only re-gates Pro OUTPUT: the debt
// cap and PDF export re-lock via refreshAfterProChange(), exactly as for a
// never-Pro user. Debts, strategy, extra payment, backups — all untouched.
function handleAccessStopIfRevoked() {
  let isPro = false;
  try { isPro = Billing.isPro(); } catch (e) { isPro = false; }
  if (isPro) { markWasProIfActive(); return false; } // still Pro — keep the flag fresh
  if (!wasPro()) return false; // never was Pro here (or already handled) — nothing to do

  // Verified revocation. Do all four steps, then re-gate the UI.
  clearWasPro(); // (2) so the notice never repeats
  try { localStorage.removeItem(CELEBRATED_KEY); } catch (e) { /* (3) re-buy celebrates fresh */ }
  showAccessEndedNotice(); // (1) one-time calm, dismissible notice
  refreshAfterProChange(); // (4) re-lock gated buttons; hide license link + self-heal nag
  return true;
}

// One-time calm, dismissible access-ended banner. Reuses the same slim banner
// slot/id as the save/self-heal nags (#saveNagBanner) so only one shows at a
// time, and refreshAfterProChange()'s nag helpers no-op while it's up (an
// ex-owner isn't Pro and has no code, so neither nag qualifies). No guilt, no
// re-sell — just reassurance that their work is safe and free features remain.
function showAccessEndedNotice() {
  const existing = $("#saveNagBanner");
  if (existing) existing.remove();
  const bar = el("div", "save-nag access-ended"); bar.id = "saveNagBanner";
  // Say WHY it usually happens (a refund) and give the path out if it's a mistake —
  // "access ended" with no reason or contact reads as a broken "yours forever" promise.
  bar.appendChild(txt("span", "save-nag-text", "Your Pro access has ended — this usually follows a refund. If it's unexpected, email " + SUPPORT_EMAIL + " and we'll sort it out. Everything you made is safe and still here, and every free feature keeps working — you're always welcome back."));
  const close = txt("button", "save-nag-close", "×"); close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => bar.remove();
  bar.appendChild(close);
  document.body.insertBefore(bar, document.body.firstChild);
  announce("Your Pro access has ended — this usually follows a refund. If it's unexpected, email " + SUPPORT_EMAIL + " and we'll sort it out. Everything you made is safe and still here, and every free feature keeps working.", false);
}

// ── Refund request (customer-initiated, request-only) ─────────────────────
// A refund is money movement, so the app NEVER executes it — this only makes
// ASKING effortless via a pre-filled email to support. A human reviews and
// processes it. Builds a mailto: with the person's restore code auto-inserted.
function refundMailtoHref() {
  let code = null;
  try { code = Billing.getRestoreCode(); } catch (e) { code = null; }
  const subject = "Refund request — My Snowball Pro";
  const body =
    "Hi My Snowball team,\n\n" +
    "I'd like to request a refund for my Pro purchase.\n\n" +
    "My restore code: " + (code || "(no code on this device)") + "\n" +
    "Reason (optional): \n\n" +
    "I understand a real person will review this and reply. Thanks!\n";
  return "mailto:" + SUPPORT_EMAIL +
    "?subject=" + encodeURIComponent(subject) +
    "&body=" + encodeURIComponent(body);
}

// Builds the quiet "Need a refund?" block: a calm expectations line + a mailto
// link that opens the user's own mail client with everything pre-filled. Purely
// a hand-off — no refund/charge API is ever called. Returned as a DOM node so
// callers can drop it into the license-card modal and the footer Pro area.
function buildRefundBlock() {
  const wrap = el("div", "refund-block");
  const link = txt("a", "refund-link", "Need a refund?");
  link.href = refundMailtoHref();
  // Rebuild the href at click time so a code minted mid-session is included.
  link.addEventListener("click", () => { link.href = refundMailtoHref(); });
  wrap.appendChild(link);
  wrap.appendChild(txt("p", "refund-note", "30-day money-back guarantee. Email us and a real person reviews it — no forms, no runaround. Once approved, your refund goes back to your original payment method and takes about 5–10 business days to appear on your statement."));
  return wrap;
}

// Called after any change to Pro status (unlock or restore) so gated UI reflects
// it immediately: re-render the app (unlocks the debt cap + export), reveal the
// footer license link, and refresh the save-code nag.
function refreshAfterProChange() {
  try { buildApp(); } catch (e) {}
  try { updateLicenseFooterLink(); } catch (e) {}
  try { updateRefundFooterLink(); } catch (e) {}
  try { updateSideProCard(); } catch (e) {}
  try { maybeShowSaveNag(); } catch (e) {}
  try { maybeShowSelfHealNag(); } catch (e) {}
}

// ── Modal accessibility (focus move-in, focus-trap, Escape) ───────────────
// Wraps a freshly-built backdrop/modal so keyboard + screen-reader users get a
// proper dialog: role/aria-modal, focus moves inside on open, Tab is trapped,
// focus returns to the opener on close. `opts.escCloses` (default true) wires
// Escape to close — the paywall closes on Escape; the code-save modal passes
// false so a user can't dismiss it before saving their only key back into Pro.
function makeModalAccessible(backdrop, modal, opts = {}) {
  const escCloses = opts.escCloses !== false;
  const opener = document.activeElement;
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const heading = modal.querySelector("h3");
  if (heading) {
    if (!heading.id) heading.id = "modalTitle_" + Math.random().toString(36).slice(2, 8);
    modal.setAttribute("aria-labelledby", heading.id);
  }
  const focusables = () => Array.from(modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((n) => !n.disabled && n.offsetParent !== null);
  // Move focus into the dialog (first real control, else the modal itself).
  requestAnimationFrame(() => {
    const f = focusables();
    if (f.length) f[0].focus();
    else { modal.setAttribute("tabindex", "-1"); modal.focus(); }
  });
  const onKey = (e) => {
    if (e.key === "Escape" && escCloses) { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  backdrop.addEventListener("keydown", onKey);
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    backdrop.remove();
    if (opener && typeof opener.focus === "function") { try { opener.focus(); } catch (e) {} }
  }
  return { close };
}

// ── Confetti — gentle snowfall (celebration) ──────────────────────────────
// Pure DOM/CSS, no libs, respects prefers-reduced-motion (renders nothing when
// motion is reduced — the celebration copy alone carries the moment). Self-
// removes after the fall so it never lingers. Snowball's buyer is often
// financially stressed, so this is a soft, calm drift, not a loud burst.
function launchSnowfall() {
  try {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const layer = document.createElement("div");
    layer.className = "snowfall-layer";
    layer.setAttribute("aria-hidden", "true");
    const N = 26;
    for (let i = 0; i < N; i++) {
      const flake = document.createElement("div");
      flake.className = "snowflake";
      const size = 5 + Math.random() * 8;
      flake.style.left = (Math.random() * 100) + "%";
      flake.style.width = size + "px";
      flake.style.height = size + "px";
      flake.style.opacity = String(0.5 + Math.random() * 0.5);
      flake.style.animationDuration = (3.4 + Math.random() * 2.6) + "s";
      flake.style.animationDelay = (Math.random() * 1.2) + "s";
      layer.appendChild(flake);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 7000);
  } catch (e) { /* celebration visuals are non-essential — never let them throw */ }
}

// ── Ownership celebration (once per lifetime) ─────────────────────────────
// The warm "It's yours — forever" moment shown on the FIRST successful unlock.
// Persists CELEBRATED_KEY so it never fires again (not later visits, not
// restores). `code` may be null (mint failed) — in that case we show the amber
// self-heal path in place of the code box instead of celebrating a code we
// don't have.
function hasCelebrated() {
  try { return localStorage.getItem(CELEBRATED_KEY) === "1"; } catch { return false; }
}
function markCelebrated() {
  try { localStorage.setItem(CELEBRATED_KEY, "1"); } catch { /* private browsing — may re-fire, acceptable */ }
}

function showCelebrationModal(code) {
  markCelebrated();
  launchSnowfall();
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal celebrate-modal");

  modal.appendChild(txt("h3", "celebrate-headline", "It's yours — forever."));
  modal.appendChild(txt("p", "celebrate-thanks", "Thank you. You just gave yourself a clearer path out of debt — take a breath, you've got this."));

  const unlocked = el("div", "celebrate-unlocked");
  unlocked.appendChild(txt("div", "celebrate-unlocked-title", "What you just unlocked"));
  const ul = el("ul", "celebrate-list");
  ["Plan every debt you have — no 4-debt limit", "Your full payoff plan as a PDF — every debt, in payoff order, with the date each one clears", "Refinance & balance-transfer modeler — see if a new rate actually saves you money after fees"]
    .forEach((f) => ul.appendChild(txt("li", null, f)));
  unlocked.appendChild(ul);
  modal.appendChild(unlocked);

  const a11y = makeModalAccessible(backdrop, modal, { escCloses: false });

  if (code) {
    // Normal path: reveal the save-your-code / license-card section inline.
    modal.appendChild(txt("p", "celebrate-code-lead", "One last thing — save your restore code. My Snowball keeps no accounts, so this code is your key to unlock Pro in another browser — on your phone or computer."));
    const codeBox = el("div", "restore-code-box");
    codeBox.appendChild(txt("code", "restore-code-value", code));
    codeBox.appendChild(copyCodeButton(code));
    modal.appendChild(codeBox);
    const canvas = Billing.renderLicenseCard(code, "My Snowball");
    canvas.className = "license-card-canvas";
    modal.appendChild(canvas);
    const actions = el("div", "pro-actions license-actions");
    const savedBtn = txt("button", "btn big", "I've saved it"); savedBtn.type = "button";
    savedBtn.onclick = () => { markCodeAcknowledged(); a11y.close(); refreshAfterProChange(); runPendingProIntent(); };
    actions.append(licenseDownloadButton(canvas), savedBtn);
    modal.appendChild(actions);
  } else if (IS_NATIVE) {
    // Apple IAP mints no restore CODE — cross-device restore is handled by the Apple ID +
    // "Restore Purchases", so skip the mint section entirely and show a clean success.
    modal.appendChild(txt("p", "hint", "Pro is unlocked on this device — and it restores free on your other Apple devices. Just tap “Restore Purchases” there, signed in with the same Apple Account."));
    const actions = el("div", "pro-actions");
    const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
    doneBtn.onclick = () => { a11y.close(); refreshAfterProChange(); runPendingProIntent(); };
    actions.appendChild(doneBtn);
    modal.appendChild(actions);
  } else {
    // Mint failed: celebrate anyway, offer to create the code (amber, honest).
    appendMintCodeSection(modal, a11y);
  }

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  return { backdrop, modal, a11y };
}

// Amber "we couldn't create your restore code" section + [Create my restore code]
// button. Used both inside the celebration (mint-failed) and anywhere else we
// have Pro-but-no-code. On success it swaps in the normal save-code modal.
function appendMintCodeSection(modal, a11y) {
  const host = el("div", "mint-code-section");
  host.appendChild(txt("p", "mint-code-note", "One thing — we couldn't create your restore code just now. Pro already works on this browser. Tap to create your code for other devices."));
  const msg = el("div", "pro-msg");
  const btn = txt("button", "btn big", "Create my restore code"); btn.type = "button";
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Creating…";
    let res;
    try { res = await Billing.mintRestoreCode(); }
    catch (e) { res = { ok: false, restoreCode: null }; }
    if (res && res.ok && res.restoreCode) {
      a11y.close();
      refreshAfterProChange();
      showRestoreCodeModal(res.restoreCode);
    } else {
      btn.disabled = false; btn.textContent = "Create my restore code";
      msg.innerHTML = "";
      const line = `No luck yet — Pro still works here; we'll offer again next visit, and ${SUPPORT_EMAIL} + your receipt always work.`;
      announce(line, false);
      const s = el("div", "status-msg err");
      s.appendChild(document.createTextNode(line));
      msg.appendChild(s);
    }
  };
  const closeBtn = txt("button", "btn ghost", "Maybe later"); closeBtn.type = "button";
  closeBtn.onclick = () => { a11y.close(); refreshAfterProChange(); runPendingProIntent(); };
  const actions = el("div", "pro-actions"); actions.append(btn, closeBtn);
  host.append(actions, msg);
  modal.appendChild(host);
}

// Central "purchase came back ok" handler — celebration exactly once, then the
// code/save flow. On repeat purchases (celebration already spent) it just shows
// the code-save modal (or the mint path) and resumes any pending intent.
function handlePurchaseSuccess(restoreCode) {
  if (!hasCelebrated()) {
    showCelebrationModal(restoreCode);
    return;
  }
  refreshAfterProChange();
  if (restoreCode) { showRestoreCodeModal(restoreCode); }
  else {
    // Already celebrated but no code (rare) — offer the self-heal nag/flow.
    runPendingProIntent();
  }
}

// Called when the charge SUCCEEDED but the entitlement is still attaching (billing
// returned { pending:true }). The customer HAS paid — so this must never read as a
// failure. Reassure, give them their restore code now, and quietly promote to a full
// unlock the moment the entitlement lands (no manual reload needed).
function handlePurchasePending(restoreCode, message) {
  const msg = message || "Your payment went through — your Pro is unlocking now. If it doesn't appear in a moment, reload this page.";
  announce(msg, false);
  showToast("Payment received — unlocking your Pro…");
  if (restoreCode) showRestoreCodeModal(restoreCode); // they paid; hand over their key straight away
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    let pro = false;
    try { pro = await Billing.refreshProStatus(); } catch (e) { pro = false; }
    if (pro || tries >= 4) {
      clearInterval(timer);
      if (pro) { markWasProIfActive(); refreshAfterProChange(); }
    }
  }, 2500);
}

// `context` (optional) personalizes the opening line to the situation that
// triggered the paywall. Default (no arg) is unchanged:
//   { reason: "debtCap", count }  — hit the free debt limit; count = current
//                                   number of debts (e.g. "You have 4 debts…")
//   { reason: "exportPdf" }       — tried to export the payoff plan
// Any unrecognized/absent context just omits the personalized line. The
// feature bullets below are always shown regardless of context.
// Guards against two paywall backdrops stacking (double-click on a gated
// button while the entitlement check is in flight, or two gates firing).
let _paywallOpen = false;

// Polished, on-brand error STATE shown when Billing.purchasePro() resolves to a
// genuine failure (NOT cancelled, NOT offline — those keep their gentle notes).
// Renders into the same paywall message host as the plain status line did.
// `onRetry` re-runs the SAME purchase flow (the Unlock Pro handler), so billing
// is never reimplemented here. Substance of the copy is unchanged.
function renderPurchaseError(msgHost, onRetry) {
  msgHost.innerHTML = "";
  // Assertive announce for AT (mirrors the old showStatus("…","err") call).
  // "no charge was made just now" (not "nothing was charged"): scoped to THIS attempt — honest
  // even if an earlier attempt did charge.
  announce("Something went wrong. If your card was charged, your Pro will unlock automatically on your next visit — otherwise no charge was made just now. " + (IS_NATIVE ? "Your App Store receipt is the record of what was charged, if anything." : "You're covered by our 30-day money-back guarantee.") + " Still stuck? Email " + SUPPORT_EMAIL + (IS_NATIVE ? " with your App Store receipt and we'll sort it out." : " with your Stripe receipt and we'll sort it out."), true);

  const box = el("div", "purchase-error");
  box.setAttribute("role", "alert");
  box.setAttribute("aria-live", "assertive");

  // Tasteful inline-SVG error mark: soft danger circle + X, gentle glow.
  const mark = el("div", "purchase-error-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML =
    '<svg viewBox="0 0 48 48" width="48" height="48" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
      '<circle class="pe-glow" cx="24" cy="24" r="21"/>' +
      '<circle class="pe-ring" cx="24" cy="24" r="15"/>' +
      '<path class="pe-x" d="M18.5 18.5 L29.5 29.5 M29.5 18.5 L18.5 29.5" />' +
    '</svg>';
  box.appendChild(mark);

  box.appendChild(txt("h4", "purchase-error-title", "Something went wrong"));
  box.appendChild(txt("p", "purchase-error-body",
    "If your card was charged, your Pro will unlock automatically on your next visit — otherwise no charge was made just now."));
  // On iOS, Apple owns IAP charges and refunds — no self-run money-back promise
  // (mirrors Local Invoice's gated wording). Web keeps the exact existing copy.
  box.appendChild(txt("p", "purchase-error-reassure", IS_NATIVE
    ? "Your App Store receipt is the record of what was charged, if anything."
    : "You're covered by our 30-day money-back guarantee."));

  // Support line — email as a mailto: link (allowed), business email as text.
  const support = txt("p", "purchase-error-support", "Still stuck? Email ");
  const mail = txt("a", "purchase-error-mail", SUPPORT_EMAIL);
  mail.href = "mailto:" + SUPPORT_EMAIL;
  support.appendChild(mail);
  support.appendChild(document.createTextNode(IS_NATIVE ? " with your App Store receipt and we'll sort it out." : " with your Stripe receipt and we'll sort it out."));
  box.appendChild(support);

  // Primary "Try again" — re-runs the SAME purchase flow the Unlock Pro button uses.
  const retry = txt("button", "btn big purchase-error-retry", "Try again");
  retry.type = "button";
  retry.onclick = () => { if (typeof onRetry === "function") onRetry(); };
  box.appendChild(retry);

  msgHost.appendChild(box);
  // Move focus to the retry control so keyboard/AT users land on the next action.
  try { retry.focus(); } catch (_) {}
}

// True when localStorage genuinely persists — probed with a real set/remove, because a
// private window can accept writes it won't keep. Used for one gentle paywall heads-up:
// in that state the minted restore code would be forgotten when the window closes.
function storageProbeOk() {
  try {
    localStorage.setItem("snowball.storage_probe", "1");
    localStorage.removeItem("snowball.storage_probe");
    return true;
  } catch (e) { return false; }
}

// ── iOS localized price (App Store storefront currency) ───────────────────
// The "$9.99" literals in this file are the true WEB price, but on iOS Apple
// charges the buyer's own storefront price (€/£/₺ …), so a non-US buyer would
// see the number change at Apple's payment sheet. On native we fetch Apple's
// own priceString once (best-effort, cached) and swap it into every visible
// price label — the hardcoded string stays as the instant placeholder and the
// fallback on any failure. Web never fetches and is byte-identical in behavior.
let _nativePriceString = null;   // Apple's localized priceString once fetched (e.g. "€9,99")
let _nativePriceInFlight = false;
function nativePriceOr(fallback) { return _nativePriceString || fallback; }
// Swap the fetched price into every label currently on screen. Labels opt in with
// data-native-price="template with {price}", so late-arriving fetches update live.
function refreshNativePriceLabels() {
  if (!_nativePriceString) return;
  const p = _nativePriceString;
  document.querySelectorAll("[data-native-price]").forEach((n) => {
    n.textContent = n.getAttribute("data-native-price").replace("{price}", p);
  });
  // Sidebar Unlock-Pro card is static HTML (index.html) — update its price line + aria-label.
  const card = $("#sideProCard");
  if (card) {
    const priceEl = card.querySelector(".side-pro-price");
    if (priceEl) priceEl.textContent = p + " · one-time";
    card.setAttribute("aria-label", "Unlock My Snowball Pro — " + p + " one-time");
  }
}
function ensureNativePrice() {
  if (!IS_NATIVE || _nativePriceString || _nativePriceInFlight) return;
  // Guard: an older billing.js bundle without this helper must never break a price label.
  if (!(window.Billing && typeof Billing.getNativeLocalizedPrice === "function")) return;
  _nativePriceInFlight = true;
  Billing.getNativeLocalizedPrice().then((p) => {
    _nativePriceInFlight = false; // a null result may retry on the next label render
    if (typeof p === "string" && p) { _nativePriceString = p; refreshNativePriceLabels(); }
  }).catch(() => { _nativePriceInFlight = false; /* cosmetic only — keep the fallback */ });
}

function showProModal(context) {
  if (_paywallOpen && $(".pro-modal") && !$(".celebrate-modal")) return;
  _paywallOpen = true;
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.appendChild(txt("h3", null, "My Snowball Pro"));
  // Optional personalized lead-in — textContent-only (count is app-derived,
  // but stays textContent to honor the app's no-innerHTML-for-data rule).
  let lead = null;
  if (context && context.reason === "debtCap" && Number.isFinite(context.count)) {
    lead = `You have ${context.count} debts — plan all of them with Pro`;
  } else if (context && context.reason === "exportPdf") {
    lead = "Take your plan with you — export it as a PDF";
  } else if (context && context.reason === "refinance") {
    lead = "See whether refinancing a debt actually saves money";
  }
  if (lead) modal.appendChild(txt("p", "pro-lead", lead));
  const price = el("div", "pro-price");
  // On iOS this label should match Apple's payment sheet, so it renders the cached
  // localized priceString when we have it and swaps in live when the fetch lands
  // ("$9.99" is the instant placeholder/fallback). On web it's simply "$9.99".
  const priceAmt = txt("span", "pro-price-amt", IS_NATIVE ? nativePriceOr("$9.99") : "$9.99");
  if (IS_NATIVE) { priceAmt.setAttribute("data-native-price", "{price}"); ensureNativePrice(); }
  price.appendChild(priceAmt);
  price.appendChild(txt("span", "pro-price-note", " one-time"));
  modal.appendChild(price);
  // Outcome-framed benefit bullets (experience-audit copy).
  const list = el("ul", "pro-features");
  [
    "Plan every debt you have — no 4-debt limit",
    "Your full payoff plan as a PDF — every debt, the exact payoff order, and the date each one clears",
    "Refinance & balance-transfer modeler — see whether moving a debt to a lower rate (after the fee) actually saves you money.",
  ].forEach((f) => list.appendChild(txt("li", null, f)));
  modal.appendChild(list);
  // Durable one-time reassurance line (never "subscription"/"plan"/"trial").
  modal.appendChild(txt("p", "pro-reassure-durable", "One-time unlock — yours forever. No subscription. (Apps that help you get out of debt shouldn't charge you monthly.)"));
  const msgHost = el("div", "pro-msg");
  msgHost.setAttribute("role", "status");
  msgHost.setAttribute("aria-live", "polite");
  // Pre-frame the checkout so the pay moment feels safe: what the email is for,
  // that it's not an account, and that we never see the card. Small muted text.
  if (IS_NATIVE) {
    // Apple IAP: no Stripe, no email receipt, no "your statement" (Apple bills), no self-run
    // money-back (refunds go through Apple's Report a Problem). One clean line replaces all three.
    modal.appendChild(txt("p", "hint pro-reassure", "Payment is handled securely by the App Store, with the Apple Account you already use — it restores free on your other Apple devices."));
  } else {
    // Name BOTH payment brands up front: the hosted checkout's own header says
    // "Secure checkout by RevenueCat", so pre-framing only Stripe made a third
    // name appear mid-payment. Now every name the buyer meets was announced here.
    modal.appendChild(txt("p", "hint pro-reassure", "Secure checkout by Stripe (via RevenueCat). You'll enter an email for your receipt only — it's not an account, and we never see your card."));
    modal.appendChild(txt("p", "hint pro-reassure", "30-day money-back guarantee — email " + SUPPORT_EMAIL + "."));
    // Statement descriptor: Snowball is part of the Eden Apps family, so the card
    // charge reads "EDEN APPS". Name it at the pay moment so a buyer isn't confused.
    {
      const stmtNote = document.createElement("p");
      stmtNote.style.cssText = "margin:12px 0 0; font-size:13.5px; font-weight:500;";
      stmtNote.innerHTML = 'Shows on your statement as <strong>“Eden Apps”</strong>';
      modal.appendChild(stmtNote);
    }
    // Cross-store honesty, said once BEFORE paying: the iOS app is a separate Apple
    // In-App Purchase (App Store rules), so a web Pro doesn't transfer there. Saying
    // it pre-purchase keeps "yours forever" from being read as "on my iPhone too".
    modal.appendChild(txt("p", "hint pro-reassure", "The iPhone and iPad app sells Pro separately through the App Store."));
    // Private-browsing heads-up (web only): this window won't keep the restore code, and the
    // code is the only key back into Pro — one plain line before they pay, said once.
    if (!storageProbeOk()) {
      modal.appendChild(txt("p", "hint pro-reassure", "Heads up — this browser isn't saving data, so keep your receipt and restore code somewhere safe after you buy."));
    }
  }
  const a11y = makeModalAccessible(backdrop, modal, { escCloses: true });
  const close = () => { _paywallOpen = false; a11y.close(); };

  const showStatus = (text, tone) => {
    // tone: "err" (red/assertive), "info" (grey/status), "ok"
    msgHost.innerHTML = "";
    if (!text) return;
    announce(text, tone === "err");
    const s = el("div", "status-msg " + (tone === "err" ? "err" : tone === "ok" ? "ok" : "info"));
    s.setAttribute("role", "status");
    s.appendChild(document.createTextNode(text));
    msgHost.appendChild(s);
  };

  const buyBtn = txt("button", "btn big", "Unlock Pro"); buyBtn.type = "button";
  buyBtn.onclick = async () => {
    if (buyBtn.disabled) return; // guard double-click
    buyBtn.disabled = true; buyBtn.textContent = "Processing…";
    showStatus("", null);
    let res;
    try { res = await Billing.purchasePro(); }
    catch (e) { res = { ok: false, error: "Something went wrong finishing up." }; }

    if (res && res.ok) {
      // PAID. Celebrate (once) + code/save flow, whether or not a code minted.
      close();
      handlePurchaseSuccess(res.restoreCode || null);
      return;
    }
    // Not ok — branch on the exact failure shape. Reset the button in every case.
    buyBtn.disabled = false; buyBtn.textContent = "Unlock Pro";
    if (res && res.inFlight) {
      // A purchase from a moment ago is still settling (entitlement attaching). Don't open a
      // second checkout or show an error card — reassure, and Pro unlocks itself when it lands.
      showStatus("Your purchase is still going through — give it a moment and Pro will unlock automatically.", "info");
    } else if (res && res.cancelled) {
      // Deliberate close — neutral/grey, never red, no retry-nag.
      showStatus("No charge was made — Pro will be here whenever you're ready.", "info");
    } else if (res && res.offline) {
      // Scoped to THIS attempt ("just now") — honest even if an earlier attempt did charge.
      showStatus("You're offline — buying Pro needs a connection for the secure checkout. Everything else works offline, and no charge was made just now.", "info");
    } else if (res && res.pending) {
      // PAID — the charge SUCCEEDED; the entitlement is only still attaching (a few seconds).
      // Never show the "purchase didn't start / you weren't charged" card or a re-buy button to
      // someone who just paid. Reassure, hand over the code, and auto-unlock when it lands.
      close();
      handlePurchasePending(res.restoreCode || null, res.error);
    } else {
      // Ambiguous failure — polished, on-brand error STATE. Re-runs the SAME
      // purchase flow (this very handler) on "Try again". Copy never asserts
      // "nothing was charged".
      renderPurchaseError(msgHost, () => buyBtn.onclick());
    }
  };
  const closeBtn = txt("button", "btn ghost", "Not now"); closeBtn.type = "button";
  closeBtn.onclick = () => close();
  const restoreLink = txt("button", "restore-link", IS_NATIVE ? "Restore Purchases" : "Already Pro? Restore with a code"); restoreLink.type = "button";
  if (IS_NATIVE) {
    // Apple's required "Restore Purchases": re-syncs this Apple ID's receipt with the App Store.
    // No typed restore code on iOS — Apple carries the entitlement across the buyer's devices.
    restoreLink.onclick = async () => {
      const prev = restoreLink.textContent;
      restoreLink.disabled = true; restoreLink.textContent = "Restoring…";
      let res;
      try { res = await Billing.restorePurchases(); }
      catch (e) { console.error("Snowball: restore threw", e); res = { ok: false }; }
      if (res && res.ok) {
        close();
        announce("Welcome back — Pro is unlocked on this device.", false);
        showToast("Welcome back — Pro is unlocked on this device.");
        refreshAfterProChange();
        runPendingProIntent();
      } else {
        restoreLink.disabled = false; restoreLink.textContent = prev;
        showStatus("No previous purchase found. Make sure you're signed in with the Apple Account you bought Pro with.", "info");
      }
    };
  } else {
    restoreLink.onclick = () => { close(); showRestoreEntryModal(); };
  }
  const actions = el("div", "pro-actions"); actions.append(buyBtn, closeBtn);
  modal.append(actions, msgHost, restoreLink);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
}

// ── Data vault (back up / restore everything, still no accounts) ────────
// The vault file is the SAME state object persistNow() writes to
// localStorage — plus the Pro restore code — so an import goes back through
// the exact sanitizeState() guards boot-loaded data does.
// ── Backup-trust helpers (honest local data-loss defense) ──────────────────
function recordBackupNow() { try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch { /* private-mode: just no timestamp */ } }
function getLastBackup() { try { const v = localStorage.getItem(LAST_BACKUP_KEY); if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; } catch { return null; } }
function relTimeSince(date) {
  if (!date) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `on ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}
// Backed up recently enough that we won't nudge (never backed up, or >45 days, nudges).
function backupIsStale() { const d = getLastBackup(); if (!d) return true; return (Date.now() - d.getTime()) > 45 * 86400000; }
// There's real data worth protecting (entered a balance, logged a month, or shelved a debt).
function hasProtectableData() {
  return (Array.isArray(state.debts) && state.debts.some((d) => d.balance > 0))
    || (Array.isArray(state.closedDebts) && state.closedDebts.length > 0)
    || (Array.isArray(state.checkins) && state.checkins.length > 0);
}
let backupNudgeDismissed = false; // session-only: hide the nudge until next load / until they back up
function buildBackupNudge() {
  if (backupNudgeDismissed || !hasProtectableData() || !backupIsStale()) return null;
  const never = !getLastBackup();
  const box = el("div", "backup-nudge");
  const ic = el("span", "backup-nudge-ic"); ic.setAttribute("aria-hidden", "true"); ic.innerHTML = (typeof SETTINGS_ICONS !== "undefined" && SETTINGS_ICONS.vault) || "";
  box.appendChild(ic);
  const body = el("div", "backup-nudge-body");
  body.appendChild(txt("div", "backup-nudge-title", never ? "Keep your plan safe" : "Time for a fresh backup"));
  body.appendChild(txt("div", "backup-nudge-msg", never
    ? "Your data lives only on this device. Save a backup file so clearing your browser can never wipe your plan."
    : "It's been a while since your last backup — a quick save keeps your progress safe."));
  box.appendChild(body);
  const acts = el("div", "backup-nudge-acts");
  const go = txt("button", "btn brand sm", "Back up now"); go.type = "button"; go.onclick = () => exportVault();
  const later = txt("button", "backup-nudge-dismiss", "Later"); later.type = "button"; later.onclick = () => { backupNudgeDismissed = true; buildApp(); };
  acts.append(go, later);
  box.appendChild(acts);
  return box;
}

async function exportVault() {
  flushPendingSave(); // in-memory `state` is now exactly what's persisted
  const payload = {
    app: VAULT_APP_ID,
    version: 1,
    exportedAt: new Date().toISOString(),
    state,
    proRestoreCode: Billing.getRestoreCode() || null,
  };
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const filename = `snowball-backup-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      // WKWebView ignores <a download>, so on iPhone/iPad we write the file and hand it to the
      // native share sheet — otherwise "Back up your data" would silently save NOTHING (mirrors
      // downloadPdfBytes / the license-card PNG save, the pattern the rest of the app uses).
      const { Filesystem, Share } = window.Capacitor.Plugins;
      const base64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
      const { uri } = await Filesystem.writeFile({ path: filename, data: base64, directory: "CACHE" });
      await Share.share({ title: filename, files: [uri] });
    } else {
      const a = document.createElement("a"); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
    }
    // Record the backup ONLY after the save/share actually completed — never show a false
    // "last backed up" (and clear the reminder) if a native share was cancelled or the write failed.
    recordBackupNow();
    buildApp(); // refresh the "last backed up" line + clear any stale-backup nudge
  } catch (e) {
    // Native share cancelled or write failed — do NOT record a backup that never happened.
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

// ── Payoff plan PDF export (Pro) ───────────────────────────────────────────
// Builds a clean one-page PDF of the current plan via window.PDFLib. All local
// canvas/byte work — no network, matching the app's on-device promise.
async function exportPayoffPlanPdf(activeDebts, primary, statusHost) {
  const setStatus = (message, ok) => {
    announce(message, !ok);
    if (!statusHost) return;
    const old = statusHost.querySelector(".status-msg");
    if (old) old.remove();
    const s = el("div", `status-msg ${ok ? "ok" : "err"}`);
    s.appendChild(document.createTextNode(message));
    statusHost.appendChild(s);
  };
  try {
    await ensurePdfLib(); // loads pdf-lib on demand (first export)
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(StandardFonts.Helvetica);

    const ink = rgb(0.10, 0.10, 0.18);
    const muted = rgb(0.42, 0.45, 0.5);
    const brand = rgb(0.055, 0.451, 0.565); // --brand #0e7490
    const line = rgb(0.85, 0.85, 0.88);

    const pageWidth = 612, pageHeight = 792; // US Letter, points
    const marginX = 54;
    const contentWidth = pageWidth - marginX * 2;
    const rightEdge = pageWidth - marginX;
    const bottomLimit = 54;
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawRectangle({ x: 0, y: pageHeight - 10, width: pageWidth, height: 10, color: brand });
    let y = pageHeight - 62;

    const ensureRoom = (needed) => { if (y - needed < bottomLimit) y = bottomLimit; };
    const text = (s, x, size, font, color) => page.drawText(pdfSafe(s), { x, y, size, font, color });

    // Title + date.
    text("Debt Payoff Plan", marginX, 22, bold, ink); y -= 22;
    text(`Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, marginX, 10, reg, muted);
    y -= 28;

    const strategyName = state.strategy === "avalanche" ? "Avalanche (highest interest first)" : "Snowball (smallest balance first)";
    const debtFreeDate = primary.neverPaysOff ? "Not within 50 years" : formatDate(addMonths(new Date(), primary.months));

    // Summary block.
    const summary = [
      ["Strategy", strategyName],
      ["Debt-free date", debtFreeDate],
      ["Time to freedom", monthsLabel(primary.months)],
      ["Total interest paid", moneyPrecise(primary.totalInterest)],
      ["Extra payment / month", moneyPrecise(safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY }))],
    ];
    summary.forEach(([k, v]) => {
      ensureRoom(16);
      text(k, marginX, 10.5, bold, muted);
      page.drawText(pdfSafe(v), { x: marginX + 150, y, size: 10.5, font: reg, color: ink });
      y -= 16;
    });
    y -= 8;

    // Your debts section.
    ensureRoom(20);
    text("Your debts", marginX, 12, bold, brand); y -= 6;
    page.drawLine({ start: { x: marginX, y }, end: { x: rightEdge, y }, thickness: 1, color: line }); y -= 16;
    // Column header.
    text("Debt", marginX, 9, bold, muted);
    page.drawText("Balance", { x: marginX + 250, y, size: 9, font: bold, color: muted });
    page.drawText("APR", { x: marginX + 360, y, size: 9, font: bold, color: muted });
    y -= 14;
    activeDebts.forEach((d) => {
      ensureRoom(14);
      page.drawText(fitPdf(reg, d.name.trim() || "Untitled debt", 10, 240), { x: marginX, y, size: 10, font: reg, color: ink });
      page.drawText(pdfSafe(moneyPrecise(d.balance)), { x: marginX + 250, y, size: 10, font: reg, color: ink });
      page.drawText(pdfSafe(`${d.apr}%`), { x: marginX + 360, y, size: 10, font: reg, color: ink });
      y -= 14;
    });
    y -= 12;

    // Payoff order section.
    ensureRoom(20);
    text("Payoff order", marginX, 12, bold, brand); y -= 6;
    page.drawLine({ start: { x: marginX, y }, end: { x: rightEdge, y }, thickness: 1, color: line }); y -= 16;
    const ranked = [...activeDebts].sort((a, b) => (primary.payoffMonth[a.id] || Infinity) - (primary.payoffMonth[b.id] || Infinity));
    ranked.forEach((d, i) => {
      ensureRoom(14);
      const payoffM = primary.payoffMonth[d.id];
      const when = payoffM ? formatDate(addMonths(new Date(), payoffM)) : "beyond 50 years";
      page.drawText(fitPdf(reg, `${i + 1}. ${d.name.trim() || "Untitled debt"}`, 10, 300), { x: marginX, y, size: 10, font: reg, color: ink });
      page.drawText(pdfSafe(when), { x: rightEdge - reg.widthOfTextAtSize(pdfSafe(when), 10), y, size: 10, font: reg, color: muted });
      y -= 14;
    });

    // Footer.
    page.drawText("Made with My Snowball — a private, on-device debt payoff planner. mysnowballapp.com",
      { x: marginX, y: 34, size: 8, font: reg, color: muted });

    const bytes = await pdf.save();
    await downloadPdfBytes(bytes, `snowball-payoff-plan-${pdfDateStamp()}.pdf`);
    setStatus("PDF ready — saved to your downloads.", true);
  } catch (e) {
    setStatus("Couldn't export the PDF — try again. Your data on this device is unaffected.", false);
  }
}
// Truncates text to fit maxWidth at the given font/size using real glyph
// widths so PDF text never overflows its column.
function fitPdf(font, text, size, maxWidth) {
  const safe = pdfSafe(text);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let lo = 0, hi = safe.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(safe.slice(0, mid) + "…", size) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return safe.slice(0, lo) + "…";
}
function pdfDateStamp() {
  const d = new Date(); const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
// Safari treats a blob: URL typed "application/pdf" as viewable and opens its
// own viewer instead of honoring <a download>, so the file never reaches
// Downloads. "application/octet-stream" has no built-in viewer, so every
// browser saves it — the .pdf filename is what makes it open correctly after.
async function downloadPdfBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    const { Filesystem } = window.Capacitor.Plugins;
    const { Share } = window.Capacitor.Plugins;
    const base64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
    const { uri } = await Filesystem.writeFile({ path: filename, data: base64, directory: "CACHE" });
    await Share.share({ title: filename, files: [uri] });
  } else {
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

// ── Shareable "debt-free" milestone card (free) ────────────────────────────
// Renders a branded, square social card onto an offscreen canvas summarizing
// the current plan's finish line, then shares it (Web Share with files) or
// falls back to a PNG download. All local canvas work — no network, matching
// the app's on-device promise and mirroring Billing.renderLicenseCard's style.
//
// `plan` is the object shape returned by simulateStrategy(): it must be a
// valid, resolvable plan (months > 0, !neverPaysOff) — callers gate on that.
// The drawn headline is derived from the SAME dateStr the results panel shows,
// so the card can never disagree with the on-screen debt-free date.
function renderMilestoneCard(plan, debtCount, dateStr) {
  const S = 1200; // square social card
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");

  const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  // Brand-gradient background so the card reads as its own image regardless of
  // the app's light/dark theme (the exported PNG is fixed light-on-brand).
  const bg = ctx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, "#0e7490"); // --brand
  bg.addColorStop(1, "#155e75"); // --brand-dark
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);

  // Inset white card panel with a subtle border, leaving a brand frame.
  const M = 72; // outer margin (brand frame width)
  const cardX = M, cardY = M, cardW = S - M * 2, cardH = S - M * 2;
  const r = 44;
  const roundRect = (x, y, w, h, rad) => {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };
  roundRect(cardX, cardY, cardW, cardH, r);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  const contentLeft = cardX + 88;
  const contentRight = cardX + cardW - 88;
  const contentW = contentRight - contentLeft;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // ── Logo mark + wordmark (top) ──
  // Rounded brand-gradient square echoing the app icon, with a white snow
  // circle + accent dots, then the "Snowball" wordmark beside it.
  const logoX = contentLeft, logoY = cardY + 108, logoSize = 96;
  const lg = ctx.createLinearGradient(logoX, logoY, logoX + logoSize, logoY + logoSize);
  lg.addColorStop(0, "#67e8f9"); // --brand-light
  lg.addColorStop(1, "#0e7490"); // --brand
  roundRect(logoX, logoY, logoSize, logoSize, 24);
  ctx.fillStyle = lg;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(logoX + logoSize * 0.46, logoY + logoSize * 0.42, logoSize * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#a5f3fc"; // --brand-border (snow speckle)
  [[0.37, 0.33, 0.045], [0.55, 0.37, 0.035], [0.45, 0.5, 0.04]].forEach(([dx, dy, dr]) => {
    ctx.beginPath();
    ctx.arc(logoX + logoSize * dx, logoY + logoSize * dy, logoSize * dr, 0, Math.PI * 2);
    ctx.fill();
  });
  // Small check-badge lower-right of the mark.
  ctx.fillStyle = "#0e7490";
  ctx.beginPath();
  ctx.arc(logoX + logoSize * 0.74, logoY + logoSize * 0.76, logoSize * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(logoX + logoSize * 0.66, logoY + logoSize * 0.76);
  ctx.lineTo(logoX + logoSize * 0.72, logoY + logoSize * 0.83);
  ctx.lineTo(logoX + logoSize * 0.82, logoY + logoSize * 0.69);
  ctx.stroke();

  ctx.fillStyle = "#155e75"; // --brand-dark
  ctx.font = `800 56px ${FONT}`;
  ctx.fillText("My Snowball", logoX + logoSize + 28, logoY + logoSize * 0.68);

  // ── Kicker ──
  ctx.fillStyle = "#0e7490";
  ctx.font = `800 30px ${FONT}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "4px";
  ctx.fillText("MY DEBT-FREE DATE", contentLeft, cardY + 300);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

  // ── Headline: "I'll be debt-free by <Month Year>" ──
  // Auto-shrinks the date line to fit the content column, then draws the two
  // lines. Kept as two visual lines so the date always gets the biggest weight.
  ctx.fillStyle = "#1a1a2e"; // --ink
  ctx.font = `700 66px ${FONT}`;
  ctx.fillText("I'll be debt-free by", contentLeft, cardY + 396);

  let dateSize = 118;
  do {
    ctx.font = `800 ${dateSize}px ${FONT}`;
    dateSize -= 4;
  } while (dateSize > 44 && ctx.measureText(dateStr).width > contentW);
  ctx.fillStyle = "#0e7490"; // --brand
  ctx.fillText(dateStr, contentLeft, cardY + 396 + dateSize + 46);

  // ── Supporting stat lines ──
  // "<N> debts · <time to freedom> · <total interest> in interest"
  const supportY = cardY + 700;
  ctx.fillStyle = "#374151";
  ctx.font = `600 40px ${FONT}`;
  const debtWord = debtCount === 1 ? "debt" : "debts";
  const line1 = `${debtCount} ${debtWord}  ·  ${monthsLabel(plan.months)} to freedom`;
  ctx.fillText(line1, contentLeft, supportY);
  ctx.fillStyle = "#6b7280"; // --muted
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText(`${money(plan.totalInterest)} in interest along the way`, contentLeft, supportY + 62);

  // ── Divider ──
  ctx.strokeStyle = "#e7e8ee"; // --line
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(contentLeft, cardY + cardH - 172);
  ctx.lineTo(contentRight, cardY + cardH - 172);
  ctx.stroke();

  // ── Footer: shield glyph + private promise + domain ──
  const footY = cardY + cardH - 108;
  // Small shield glyph (mirrors the app's privacy-pill shield).
  ctx.save();
  ctx.strokeStyle = "#0f766e"; // --ok
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const sx = contentLeft, sy = footY - 22, ss = 34;
  ctx.beginPath();
  ctx.moveTo(sx + ss / 2, sy - ss / 2);
  ctx.lineTo(sx + ss, sy - ss / 2 + ss * 0.28);
  ctx.lineTo(sx + ss, sy + ss * 0.18);
  ctx.quadraticCurveTo(sx + ss, sy + ss * 0.62, sx + ss / 2, sy + ss * 0.82);
  ctx.quadraticCurveTo(sx, sy + ss * 0.62, sx, sy + ss * 0.18);
  ctx.lineTo(sx, sy - ss / 2 + ss * 0.28);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#6b7280"; // --muted
  ctx.font = `600 27px ${FONT}`;
  ctx.fillText("Planned privately — my numbers never left my device", contentLeft + 52, footY - 4);
  ctx.fillStyle = "#155e75"; // --brand-dark
  ctx.font = `700 27px ${FONT}`;
  ctx.fillText("mysnowballapp.com", contentLeft + 52, footY + 34);

  return canvas;
}

// Feature-detects Web Share for files and shares the card as a PNG; falls back
// to a plain download of "snowball-debt-free.png" when sharing isn't offered
// (desktop, or a browser without navigator.canShare for files). Never requires
// sharing — the download path always works. `onStatus(message, ok)` surfaces
// the outcome inline near the button.
function shareMilestoneCard(canvas, onStatus) {
  const say = (m, ok) => { if (typeof onStatus === "function") onStatus(m, ok); };
  const filename = "snowball-debt-free.png";
  canvas.toBlob((blob) => {
    if (!blob) { say("Couldn't create the image — try again.", false); return; }
    const file = new File([blob], filename, { type: "image/png" });
    // Prefer the native share sheet when the browser can share this file.
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      navigator.share({ files: [file], title: "My debt-free date", text: "I'll be debt-free — planned with My Snowball." })
        .then(() => say("Shared.", true))
        .catch((e) => {
          // A user-cancelled share isn't an error; anything else falls back to a download.
          if (e && (e.name === "AbortError" || e.name === "NotAllowedError")) { say("", true); return; }
          downloadMilestonePng(blob, filename, say);
        });
      return;
    }
    downloadMilestonePng(blob, filename, say);
  }, "image/png");
}
function downloadMilestonePng(blob, filename, say) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  say("Saved to your downloads.", true);
}

function showNoticeModal(title, message, ok) {
  announce(`${title}. ${message}`, !ok);
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.appendChild(txt("h3", null, title));
  const s = el("div", `status-msg ${ok ? "ok" : "err"}`);
  s.appendChild(document.createTextNode(message));
  modal.appendChild(s);
  const closeBtn = txt("button", "btn big", "OK"); closeBtn.type = "button";
  closeBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(closeBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  return modal; // import flow appends follow-up feedback (Pro restored) here
}

function importVault(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => showNoticeModal("Restore from backup", "Couldn't read that file — try picking it again.", false);
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(String(reader.result)); }
    catch { showNoticeModal("Restore from backup", "That file isn't a My Snowball backup — it couldn't be read.", false); return; }
    if (!payload || typeof payload !== "object" || payload.app !== VAULT_APP_ID) {
      const other = payload && typeof payload.app === "string" && payload.app.trim() ? payload.app.trim() : null;
      showNoticeModal("Restore from backup", other ? `That backup is from ${other}.` : "That file doesn't look like a My Snowball backup.", false);
      return;
    }
    // Same guards boot-loaded state goes through — a hand-edited or corrupt
    // backup can't smuggle anything past sanitizeState().
    const cleaned = sanitizeState(payload.state);
    const when = payload.exportedAt && !Number.isNaN(Date.parse(payload.exportedAt))
      ? new Date(payload.exportedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "an unknown date";

    const backdrop = el("div", "modal-backdrop");
    const modal = el("div", "modal pro-modal");
    modal.appendChild(txt("h3", null, "Restore from backup"));
    modal.appendChild(txt("p", "hint", `Replace everything in this app with the backup from ${when}? Your current data will be overwritten.`));
    const goBtn = txt("button", "btn big", "Replace my data"); goBtn.type = "button";
    goBtn.onclick = () => {
      backdrop.remove();
      state = cleaned;
      persistNow();
      buildApp();
      const notice = showNoticeModal("Backup restored", "Your debts, strategy, and extra payment were replaced with the backup.", true);
      if (typeof payload.proRestoreCode === "string" && payload.proRestoreCode && !Billing.isPro()) {
        if (IS_NATIVE) {
          // No codes on iOS — full stop. A backup's web restore code is data-only here:
          // redeeming it would unlock the iOS app from a WEB purchase, contradicting the
          // "the iPhone and iPad app sells Pro separately" promise on every other surface.
          // Data is already restored above; Apple buyers get Pro back the Apple way.
          const s = el("div", "status-msg info");
          s.appendChild(document.createTextNode("Pro comes back with Restore Purchases on iPhone and iPad."));
          notice.insertBefore(s, notice.lastChild);
        } else {
        Billing.restoreWithCode(payload.proRestoreCode).then((res) => {
          if (res && res.ok) {
            buildApp(); // unlocks the Pro debt cap immediately, same as a manual restore
            const s = el("div", "status-msg ok");
            s.appendChild(document.createTextNode("Pro was restored from the code in your backup."));
            notice.insertBefore(s, notice.lastChild);
          } else {
            // Going quiet here reads as a lost purchase — say what happened, honestly.
            // restoreWithCode's own copy already splits network trouble from a code with no
            // Pro, and the retry path (code entry in the footer) is named. Web-only: the
            // native branch above never redeems a code, so no App Store wording is needed.
            const detail = (res && res.offline)
              ? "You're offline — restoring Pro needs a connection to verify your code."
              : ((res && res.error) || "Couldn't check that code — try again.");
            const s = el("div", "status-msg err");
            s.appendChild(document.createTextNode(
              "Your data was restored, but Pro didn't come back from the code in your backup. " + detail +
              " You can try again anytime — “Restore with a code” is in the footer."));
            notice.insertBefore(s, notice.lastChild);
          }
        }).catch((e) => { console.error("Snowball: backup Pro restore failed", e); /* the notice modal stays usable either way */ });
        }
      }
    };
    const cancelBtn = txt("button", "btn ghost", "Cancel"); cancelBtn.type = "button";
    cancelBtn.onclick = () => backdrop.remove();
    const actions = el("div", "pro-actions"); actions.append(goBtn, cancelBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
  };
  reader.readAsText(file);
}

// ── Hash router ────────────────────────────────────────────────────────────
// A lightweight, CSP-safe view-switch (hashchange + imperative DOM only — no
// framework, no eval, no innerHTML for data) that mounts the app's EXISTING
// builders/render-functions into three routed views. It rewrites nothing about
// the payoff math, billing, or state — buildApp() still tears down and rebuilds
// #app exactly as before; it just renders the ACTIVE route's slice.
const ROUTES = ["plan", "payoff", "settings"];
const DEFAULT_ROUTE = "plan";
const ROUTE_HERO = {
  plan: {
    h1: 'See your <span class="accent">debt-free date</span>, today',
    p: "Add your balances, pick a strategy, watch the payoff plan build — no account, no upload, nothing tracked.",
  },
  payoff: {
    h1: 'Your <span class="accent">payoff plan</span>',
    p: "Your personalized path to debt-free — payoff order, charts, and what-if tools, all figured on this device.",
  },
  settings: {
    h1: '<span class="accent">Settings</span> &amp; your data',
    p: "Your theme, your backups, and your Pro unlock — everything about how My Snowball lives on this device.",
  },
};
function currentRoute() {
  const h = String(location.hash || "").replace(/^#\/?/, "").split(/[/?]/)[0];
  return ROUTES.indexOf(h) >= 0 ? h : DEFAULT_ROUTE;
}
function updateRouteChrome(route) {
  // Nav active state: aria-current on the active link, class for styling.
  ROUTES.forEach((r) => {
    const link = $("#nav" + r.charAt(0).toUpperCase() + r.slice(1));
    if (!link) return;
    const active = r === route;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  // Route-specific hero copy. The h1 fragment is a fixed developer constant
  // (only a static <span class="accent"> wrapper), never user data, so the
  // innerHTML here matches the app's "innerHTML only for static markup" rule.
  const hero = $("#routeHero");
  const meta = ROUTE_HERO[route] || ROUTE_HERO[DEFAULT_ROUTE];
  if (hero) {
    const h1 = hero.querySelector("h1");
    const p = hero.querySelector("p");
    if (h1) h1.innerHTML = meta.h1;
    if (p) p.textContent = meta.p;
    // The Settings and Payoff routes render their own mockup-faithful hero
    // (with the vault/summit illustration) inside #app, so the shared mascot
    // hero is hidden there to avoid a duplicate headline. The Plan route keeps
    // the mascot hero (its home). Copy above still updates so nothing regresses
    // if the flag is ever removed.
    hero.classList.toggle("hero-hidden", route === "settings" || route === "payoff");
  }
}

// ── Plan view (#/plan) — inputs + at-a-glance ─────────────────────────────
// The Strategy card, extra-payment input, the debts form, and the summary
// stat tiles (with the honest empty state). Same builders as before.
function renderPlanView(root) {
  const grid = el("div", "app-grid");
  const formCol = el("div");
  const resultsCol = el("div", "preview-wrap");
  grid.append(formCol, resultsCol);
  root.appendChild(grid);

  // ── Strategy ──
  const stPanel = el("div", "panel");
  stPanel.appendChild(panelTitle("Strategy", "strategy"));
  const picker = el("div", "strategy-picker");
  [
    ["snowball", "Snowball", "Smallest balance first — quick wins build momentum."],
    ["avalanche", "Avalanche", "Highest interest rate first — mathematically the cheapest."],
    ["custom", "Custom", "Pay them off in an order you choose."],
  ].forEach(([id, name, desc]) => {
    const opt = el("button", `strategy-opt${state.strategy === id ? " active" : ""}`);
    opt.type = "button";
    opt.setAttribute("aria-pressed", state.strategy === id ? "true" : "false");
    opt.appendChild(txt("span", "st-name", name));
    opt.appendChild(txt("span", "st-desc", desc));
    opt.onclick = () => {
      state.strategy = id; persistNow(); buildApp();
    };
    picker.appendChild(opt);
  });
  stPanel.appendChild(picker);

  // ── Trade-off hint, right under the picker ──
  // Compute both strategies ONCE here (the same primary/other pair buildResults
  // uses) so the picker decision shows its price impact at the point of choice.
  // Reused below for the comparison card in the results column.
  const planActive = planScopedDebts().filter((d) => d.balance > 0 && d.minPayment > 0);
  let planPrimary = null, planOther = null;
  if (planActive.length) {
    const extra = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
    planPrimary = simulateStrategy(planActive, state.strategy, extra);
    planOther = simulateStrategy(planActive, otherStrategy(state.strategy), extra);
    stPanel.appendChild(strategyPickerHint(state.strategy, planPrimary, planOther));
  }
  if (state.strategy === "custom") {
    const col = buildCustomOrderList(planActive);
    if (col) stPanel.appendChild(col);
  }

  const extraField = field("Extra payment per month (optional)", state.extraPayment || "", (v) => { state.extraPayment = safeNumber(v, { min: 0, max: MAX_MONEY }); refreshLive(); }, { numeric: true, placeholder: "0", min: 0, max: MAX_MONEY });
  // A subtle gauge glyph inside the field (mockup) — decorative, added via a
  // marker class the CSS targets; doesn't change the input or its handler.
  extraField.classList.add("has-gauge");
  stPanel.appendChild(extraField);
  formCol.appendChild(stPanel);

  // ── Debts ──
  const debtPanel = el("div", "panel");
  debtPanel.appendChild(panelTitle("Your debts", "debts"));
  let debtsArePro = false;
  try { debtsArePro = Billing.isPro(); } catch (e) { debtsArePro = false; }
  state.debts.forEach((debt, i) => {
    const row = debtRow(debt, i);
    // Debts beyond the free cap (only reachable via an imported backup) stay
    // visible and editable, but are excluded from the free plan — marked locked
    // so it's clear they aren't counted toward the payoff plan until Pro.
    if (!debtsArePro && i >= FREE_DEBT_LIMIT) row.classList.add("debt-locked");
    debtPanel.appendChild(row);
  });
  // Over-cap upsell: shown only when a free user actually has more debts than the
  // free plan covers (i.e. imported them). Opens the SAME paywall; on unlock,
  // rebuilds so every debt joins the plan.
  if (!debtsArePro && state.debts.length > FREE_DEBT_LIMIT) {
    const extra = state.debts.length - FREE_DEBT_LIMIT;
    const lock = el("div", "debt-lock-note");
    lock.appendChild(txt("span", "debt-lock-text",
      `Your free plan covers your first ${FREE_DEBT_LIMIT} debts. ${extra} more ${extra === 1 ? "debt is" : "debts are"} saved but not included in your payoff plan.`));
    const unlock = txt("button", "btn sm", "Unlock Pro to plan every debt");
    unlock.type = "button";
    unlock.onclick = () => gateProAction(unlock, { reason: "debtCap", count: state.debts.length }, () => buildApp());
    lock.appendChild(unlock);
    debtPanel.appendChild(lock);
  }
  const addDebt = txt("button", "btn ghost sm", "+ Add debt");
  addDebt.type = "button";
  const addDebtAction = () => {
    state.debts.push({ id: genId(), name: "", balance: 0, apr: 0, minPayment: 0 }); scheduleSave(); buildApp();
  };
  addDebt.onclick = () => {
    // Free tier caps at FREE_DEBT_LIMIT debts. Under the cap, add freely (no
    // gate). At/over the cap, gate: a live entitlement check, then either add or
    // open the paywall with "add a debt" as the resume-on-unlock intent.
    if (state.debts.length < FREE_DEBT_LIMIT) { addDebtAction(); return; }
    gateProAction(addDebt, { reason: "debtCap", count: state.debts.length }, addDebtAction);
  };
  debtPanel.appendChild(addDebt);
  const note = txt("div", "autosave-note", "Saved automatically to this device."); note.id = "autosaveNote";
  // Info/success status container — announced politely to screen readers.
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  note.setAttribute("aria-atomic", "true");
  debtPanel.appendChild(note);
  formCol.appendChild(debtPanel);

  // ── The Shelf — conquered-debt trophies (free) ──
  const shelf = buildShelfSection();
  if (shelf) formCol.appendChild(shelf);

  // Link across to the detailed payoff view.
  const seeMore = el("div", "route-jump");
  const seeMoreBtn = txt("a", "btn ghost sm route-jump-link", "See your full payoff plan →");
  seeMoreBtn.href = "#/payoff";
  seeMore.appendChild(seeMoreBtn);

  // Builds the results column: summary stat tiles + the Snowball-vs-Avalanche
  // comparison card (so both strategies' interest are visible right by the
  // picker). Recomputes the sims each call so a live debt edit updates both.
  function buildResultsCol() {
    const frag = document.createDocumentFragment();
    const nudge = buildBackupNudge(); if (nudge) frag.appendChild(nudge);
    const active = planScopedDebts().filter((d) => d.balance > 0 && d.minPayment > 0);
    if (active.length) {
      const spPlan = simulateStrategy(active, state.strategy, safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY }));
      const hero = buildTotalCostHero(active, spPlan); if (hero) frag.appendChild(hero);
      const snow = buildSnowpackCard(active, spPlan); if (snow) frag.appendChild(snow);
    }
    {
      // Year-in-Review shows once there's a story (check-ins or conquered debts),
      // even with 0 active debts (all conquered). Pro-gated inside the builder.
      const yirPlan = active.length ? simulateStrategy(active, state.strategy, safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY })) : null;
      const yir = buildYearInReviewCard(active, yirPlan); if (yir) frag.appendChild(yir);
    }
    frag.appendChild(buildResults("summary"));
    if (active.length) {
      const extra = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
      const clock = buildInterestClock(active); if (clock) frag.appendChild(clock);
      const p = simulateStrategy(active, state.strategy, extra);
      const o = simulateStrategy(active, otherStrategy(state.strategy), extra);
      frag.appendChild(buildStrategyCompareCard(state.strategy, p, o));
      const trap = buildTrapXray(active, state.strategy, extra); if (trap) frag.appendChild(trap);
    }
    frag.appendChild(seeMore);
    // Reward photo (Pro) — your "why", revealed as you pay down. Shown once there's
    // a plan; a Pro teaser otherwise.
    if (active.length) { const rw = buildRewardPhotoCard(); if (rw) frag.appendChild(rw); }
    // Motivational "Small steps today, big freedom tomorrow" card — matches the
    // mockup's placement at the base of the results column. Uses the primary
    // sim (null-safe: buildMotivationCard falls back gently with no plan).
    const motivPrimary = active.length
      ? simulateStrategy(active, state.strategy, safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY }))
      : null;
    frag.appendChild(buildMotivationCard(motivPrimary));
    return frag;
  }

  // ── Summary stat tiles + strategy comparison (at-a-glance) ──
  resultsCol.appendChild(buildResultsCol());

  // Live refresh: re-render the results column as debt fields are typed, so the
  // form inputs keep focus (a full teardown would drop the caret).
  function refresh() {
    scheduleSave();
    resultsCol.innerHTML = "";
    resultsCol.appendChild(buildResultsCol());
  }
  window.__snowballRefresh = refresh;
}

// ── Payoff view (#/payoff) — the detailed harvested plan ──────────────────
// Payoff-order table, balance chart, breakdown donut, "where your money goes"
// ring, goal-seek, what-if slider, export PDF (Pro), share milestone. Same
// builders as before; no editable debt inputs live here, so a live refresh can
// safely rebuild the whole region.
// Inline-SVG icons for the Payoff harvest (mockup). Fixed developer constants
// (safe innerHTML); decorative (aria-hidden), tinted per-tile on the brand ramp.
const PAYOFF_ICONS = {
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.6 4.8L18 9.4l-4.4 1.6L12 16l-1.6-5L6 9.4l4.4-1.6z"/><path d="M19 15l.7 2.1L22 17.8l-2.3.7L19 21l-.7-2.5-2.3-.7 2.3-.7z"/></svg>',
  order: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="12" width="4" height="8" rx="1"/><rect x="10" y="8" width="4" height="12" rx="1"/><rect x="16" y="4" width="4" height="16" rx="1"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3.5-4.5L14 13l4-6"/></svg>',
  whatif: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h9M17 8h3"/><circle cx="15" cy="8" r="2"/><path d="M4 16h3M11 16h9"/><circle cx="9" cy="16" r="2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>',
  trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 7-8"/><path d="M14 7h6v6"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.3 1 2.5h6c0-1.2.3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
};

// One item of the "What you'll see" explainer panel (icon tile + title + line).
function payoffSeeRow(tone, iconKey, title, line) {
  const row = el("div", "payoff-see-row");
  const ic = el("span", `payoff-see-icon tone-${tone}`);
  ic.setAttribute("aria-hidden", "true");
  ic.innerHTML = PAYOFF_ICONS[iconKey] || "";
  const body = el("div");
  body.appendChild(txt("div", "payoff-see-title", title));
  body.appendChild(txt("div", "payoff-see-line", line));
  row.append(ic, body);
  return row;
}
// The right-hand "What you'll see" explainer + Pro tip.
function buildPayoffSeePanel() {
  const aside = el("div", "panel payoff-see");
  const head = el("div", "payoff-see-head");
  const headIc = el("span", "payoff-see-head-icon");
  headIc.setAttribute("aria-hidden", "true");
  headIc.innerHTML = PAYOFF_ICONS.spark;
  head.append(headIc, txt("span", "payoff-see-head-title", "What you'll see"));
  aside.appendChild(head);
  aside.appendChild(payoffSeeRow("brand", "order", "Payoff order", "See which debt to pay off first using the Snowball method."));
  aside.appendChild(payoffSeeRow("violet", "chart", "Charts & progress", "Visualize your progress and watch your debt shrink."));
  aside.appendChild(payoffSeeRow("green", "whatif", "What-if tools", "Try scenarios and see how extra payments help."));
  aside.appendChild(payoffSeeRow("amber", "clock", "Debt-free date", "Pick a target date and get a custom plan to reach it."));
  const tip = el("div", "payoff-see-tip");
  const tipIc = el("span", "payoff-see-tip-icon");
  tipIc.setAttribute("aria-hidden", "true");
  tipIc.innerHTML = PAYOFF_ICONS.tip;
  const tipText = el("p", "payoff-see-tip-text");
  tipText.appendChild(txt("strong", null, "Pro tip: "));
  tipText.appendChild(document.createTextNode("Add all your debts on the Plan page for the most accurate plan."));
  tip.append(tipIc, tipText);
  aside.appendChild(tip);
  return aside;
}

function renderPayoffView(root) {
  // ── Hero header + "Personalized for you" badge + summit illustration ──
  const hero = el("div", "payoff-hero");
  const heroText = el("div", "payoff-hero-text");
  const titleRow = el("div", "payoff-hero-titlerow");
  const h2 = el("h2", "payoff-hero-title");
  h2.appendChild(txt("span", null, "Your "));
  h2.appendChild(txt("span", "payoff-hero-accent", "payoff plan"));
  titleRow.appendChild(h2);
  const badge = el("span", "payoff-badge");
  const badgeIc = el("span", "payoff-badge-icon");
  badgeIc.setAttribute("aria-hidden", "true");
  badgeIc.innerHTML = PAYOFF_ICONS.spark;
  badge.append(badgeIc, txt("span", null, "Personalized for you"));
  titleRow.appendChild(badge);
  heroText.appendChild(titleRow);
  heroText.appendChild(txt("p", "payoff-hero-sub", "Your personalized path to debt-free — payoff order, charts, and what-if tools, all figured on this device."));
  const heroArt = el("div", "payoff-hero-art");
  heroArt.setAttribute("aria-hidden", "true");
  // Dimensional summit scene (Payoff mockup harvest): a layered blue mountain
  // range with gradient depth, a soft sun-glow behind the peak, snowcaps, a
  // winding dotted trail up the front face, a tree line, and a flag with a
  // glow. All fills key off theme tokens so it re-tints in dark. Decorative.
  heroArt.innerHTML =
    '<svg viewBox="0 0 260 156" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<radialGradient id="phaSun" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" class="pha-sun-hi"/><stop offset="55%" class="pha-sun-mid"/><stop offset="100%" class="pha-sun-lo"/>' +
        '</radialGradient>' +
        '<linearGradient id="phaPeak" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" class="pha-peak-hi"/><stop offset="100%" class="pha-peak-lo"/>' +
        '</linearGradient>' +
        '<linearGradient id="phaRange" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" class="pha-range-hi"/><stop offset="100%" class="pha-range-lo"/>' +
        '</linearGradient>' +
        '<linearGradient id="phaFace" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" class="pha-face-hi"/><stop offset="100%" class="pha-face-lo"/>' +
        '</linearGradient>' +
      '</defs>' +
      // soft ground shadow so the range doesn't float
      '<ellipse class="pha-ground" cx="140" cy="146" rx="104" ry="9"/>' +
      // sun-glow behind the summit
      '<circle class="pha-sun" cx="150" cy="50" r="40" fill="url(#phaSun)"/>' +
      // far range (lightest, most receded)
      '<path class="pha-range-far" d="M20 144 L70 92 L104 118 L146 78 L188 116 L226 84 L260 116 L260 144 Z"/>' +
      // mid range with gradient
      '<path class="pha-range" d="M8 144 L58 100 L92 124 L138 88 L182 122 L224 94 L260 128 L260 144 Z" fill="url(#phaRange)"/>' +
      '<path class="pha-range-cap" d="M138 88 L128 100 L136 98 L131 108 L138 104 L145 108 L140 98 L148 100 Z"/>' +
      // front summit peak — two-tone (lit face + shaded face)
      '<path class="pha-peak" d="M78 144 L152 40 L226 144 Z" fill="url(#phaPeak)"/>' +
      '<path class="pha-peak-shade" d="M152 40 L226 144 L166 144 Z" fill="url(#phaFace)"/>' +
      '<path class="pha-snowcap" d="M152 40 L131 70 L145 65 L137 82 L152 74 L167 82 L159 65 L173 70 Z"/>' +
      // winding dotted trail to the summit
      '<path class="pha-trail" d="M98 142 Q124 128 119 112 Q114 94 136 86 Q152 80 152 52" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="1.5 6.5"/>' +
      // tree line at the base
      '<path class="pha-tree" d="M92 144 l5-13 5 13 z"/>' +
      '<path class="pha-tree" d="M102 144 l4.5-11 4.5 11 z"/>' +
      '<path class="pha-tree pha-tree-far" d="M200 144 l5-12 5 12 z"/>' +
      '<path class="pha-tree pha-tree-far" d="M210 144 l4-10 4 10 z"/>' +
      // flag at the summit + glow
      '<circle class="pha-flag-glow" cx="152" cy="34" r="12"/>' +
      '<path class="pha-flagpole" d="M152 52 v-24" stroke-width="2.4" stroke-linecap="round"/>' +
      '<path class="pha-flag" d="M152 28 L170 34 L152 40 Z"/>' +
      // sparkle accents
      '<path class="pha-spark" d="M206 44l1.4 3.6 3.6 1.4-3.6 1.4-1.4 3.6-1.4-3.6-3.6-1.4 3.6-1.4z"/>' +
      '<path class="pha-spark pha-spark-sm" d="M100 58l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/>' +
    '</svg>';
  hero.append(heroText, heroArt);
  root.appendChild(hero);

  // ── Two-column body: results/goal-seek (left) + explainer (right) ──
  const grid = el("div", "payoff-grid");
  const wrap = el("div", "payoff-view");
  const aside = buildPayoffSeePanel();
  grid.append(wrap, aside);
  root.appendChild(grid);

  // Footer privacy line.
  const priv = el("div", "payoff-privacy");
  const privIc = el("span", "payoff-privacy-icon");
  privIc.setAttribute("aria-hidden", "true");
  privIc.innerHTML = PAYOFF_ICONS.shield;
  priv.append(privIc, txt("span", null, "Everything stays private on your device. No accounts. No cloud. Just you."));
  root.appendChild(priv);

  function render() {
    wrap.innerHTML = "";
    wrap.appendChild(buildResults("detail"));
    // Goal-seek + what-if belong to the detailed view. Goal-seek only makes
    // sense with at least one qualifying debt, but its own honest empty state
    // handles the no-debt case, so it's always mounted here.
    wrap.appendChild(buildGoalSeekPanel());
  }
  render();

  function refresh() { scheduleSave(); render(); }
  window.__snowballRefresh = refresh;
}

// ── Settings view (#/settings) — re-homed footer controls ─────────────────
function renderSettingsView(root) {
  root.appendChild(buildSettingsView());
  // Settings has no live-derived numbers to re-render on edit.
  window.__snowballRefresh = () => {};
}

function buildApp() {
  const root = $("#app");
  if (!root) return;
  root.innerHTML = "";
  const route = currentRoute();
  updateRouteChrome(route);

  if (route === "payoff") renderPayoffView(root);
  else if (route === "settings") renderSettingsView(root);
  else renderPlanView(root);

  // Footer "View your Pro license card" link lives outside #app but tracks
  // the same lifecycle — a code can appear mid-session (purchase/restore),
  // and every one of those paths ends in a buildApp().
  updateLicenseFooterLink();
}
function refreshLive() { if (window.__snowballRefresh) window.__snowballRefresh(); else buildApp(); }

// ── Settings view (Data Vault + theme + restore code) ──────────────────────
// Re-homes the footer controls into a proper Settings route. Every control here
// calls the SAME shipped function the footer buttons call — nothing about
// backup/restore/restore-code/theme is reimplemented, so the billing and data
// flows are byte-for-byte unchanged. The footer buttons stay wired too.
// Inline-SVG icon set for the Settings harvest (mockup). All fixed developer
// constants (safe innerHTML), tinted on the brand ramp per-chip, decorative
// (the text label carries meaning, so the icon host is aria-hidden).
const SETTINGS_ICONS = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="13" cy="12" r="3.4"/><path d="M13 8.6v1M13 15.4v-1M9.6 12h1M16.4 12h-1M7 4v16"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-1.6 10.2a1 1 0 0 1-1 .8H5.6a1 1 0 0 1-1-.8L3 8z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><circle cx="12" cy="15.5" r="1.4"/></svg>',
  cloudOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H7a4 4 0 0 1-.7-7.94A5.5 5.5 0 0 1 16 8.5"/><path d="M20 17.6a3 3 0 0 0-1.8-5.5"/><path d="M3 3l18 18"/></svg>',
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  peace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-4.2 7-9.6V5.4L12 3 5 5.4v6C5 16.8 12 21 12 21z"/><path d="M12 8v4l2.5 1.5"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.3 1 2.5h6c0-1.2.3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M8 12.5l2.5 2.5 5.5-6"/></svg>',
  brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 3.5l5 5-9 9a3 3 0 0 1-1.6.85L5 19l.65-4.9A3 3 0 0 1 6.5 12.5z"/><path d="M13.5 5.5l5 5"/><path d="M5 19c-.9 1.2-2 1.6-3 1.6.4-1 .8-2.1 2-3"/></svg>',
};

// A settings row-card: a tinted icon chip + title + description on the left,
// and its live control(s) on the right. `controls` is a node (or array of
// nodes) built by the caller so the SAME shipped handlers stay wired.
function settingsCard(tone, iconKey, title, desc, controls) {
  const card = el("div", "panel settings-card");
  const main = el("div", "settings-card-main");
  const chip = el("span", `settings-chip tone-${tone}`);
  chip.setAttribute("aria-hidden", "true");
  chip.innerHTML = SETTINGS_ICONS[iconKey] || "";
  const body = el("div", "settings-card-body");
  body.appendChild(txt("h3", "settings-card-title", title));
  body.appendChild(txt("p", "settings-card-desc", desc));
  main.append(chip, body);
  card.appendChild(main);
  if (controls) {
    const ctrlWrap = el("div", "settings-card-controls");
    (Array.isArray(controls) ? controls : [controls]).forEach((c) => c && ctrlWrap.appendChild(c));
    card.appendChild(ctrlWrap);
  }
  return card;
}
// One line of the right-hand "Your data stays with you" reassurance panel.
function dataAssureRow(tone, iconKey, title, line) {
  const row = el("div", "data-assure-row");
  const ic = el("span", `data-assure-icon tone-${tone}`);
  ic.setAttribute("aria-hidden", "true");
  ic.innerHTML = SETTINGS_ICONS[iconKey] || "";
  const body = el("div");
  body.appendChild(txt("div", "data-assure-title", title));
  body.appendChild(txt("div", "data-assure-line", line));
  row.append(ic, body);
  return row;
}

function buildSettingsView() {
  const host = el("div", "settings-view");

  // ── Hero header + vault/shield illustration (mockup harvest) ──
  const hero = el("div", "settings-hero");
  const heroText = el("div", "settings-hero-text");
  const h2 = el("h2", "settings-hero-title");
  h2.appendChild(txt("span", "settings-hero-lead", "Settings"));
  h2.appendChild(document.createTextNode(" "));
  h2.appendChild(txt("span", null, "& your data"));
  heroText.appendChild(h2);
  heroText.appendChild(txt("p", "settings-hero-sub", "Your theme, your backups, and your Pro unlock — everything about how My Snowball lives on this device."));
  const heroArt = el("div", "settings-hero-art");
  heroArt.setAttribute("aria-hidden", "true");
  // Dimensional vault scene (Settings mockup harvest): a gradient-shaded safe
  // with a glossy combination dial, a padlock, and a glossy check-shield, over
  // soft clouds with sparkle accents and a grounding shadow. Gradients key off
  // theme tokens so the art re-tints (and blends, no dark plate) in dark mode.
  heroArt.innerHTML =
    '<svg viewBox="0 0 232 156" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="shaBody" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" class="sha-body-hi"/><stop offset="100%" class="sha-body-lo"/>' +
        '</linearGradient>' +
        '<linearGradient id="shaDoor" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" class="sha-door-hi"/><stop offset="100%" class="sha-door-lo"/>' +
        '</linearGradient>' +
        '<radialGradient id="shaDial" cx="38%" cy="34%" r="75%">' +
          '<stop offset="0%" class="sha-dial-hi"/><stop offset="60%" class="sha-dial-mid"/><stop offset="100%" class="sha-dial-lo"/>' +
        '</radialGradient>' +
        '<linearGradient id="shaShield" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" class="sha-shield-hi"/><stop offset="100%" class="sha-shield-lo"/>' +
        '</linearGradient>' +
      '</defs>' +
      // soft clouds behind + grounding shadow
      '<ellipse class="sha-cloud sha-cloud-b" cx="176" cy="120" rx="52" ry="13"/>' +
      '<ellipse class="sha-cloud" cx="118" cy="132" rx="78" ry="12"/>' +
      '<ellipse class="sha-ground" cx="112" cy="130" rx="60" ry="7"/>' +
      // safe / vault body (gradient metal) + door
      '<rect class="sha-safe-body" x="58" y="30" width="100" height="94" rx="12" fill="url(#shaBody)"/>' +
      '<rect class="sha-safe-door" x="69" y="41" width="78" height="72" rx="8" fill="url(#shaDoor)"/>' +
      '<rect class="sha-safe-rim" x="69" y="41" width="78" height="72" rx="8"/>' +
      // glossy combination dial
      '<circle class="sha-dial-ring" cx="108" cy="77" r="21"/>' +
      '<circle class="sha-dial" cx="108" cy="77" r="14" fill="url(#shaDial)"/>' +
      '<path class="sha-dial-mark" d="M108 68v-4.5M108 90.5v-4.5M99 77h-4.5M121.5 77h-4.5M101.6 70.6l-3.2-3.2M117.6 86.6l-3.2-3.2M114.4 70.6l3.2-3.2M101.6 83.4l-3.2 3.2" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle class="sha-dial-hub" cx="108" cy="77" r="3.4"/>' +
      '<circle class="sha-dial-gloss" cx="103" cy="71" r="4.2"/>' +
      // handle + feet
      '<path class="sha-handle" d="M149 64v26" stroke-width="4.4" stroke-linecap="round"/>' +
      '<rect class="sha-foot" x="64" y="124" width="11" height="8" rx="2.5"/>' +
      '<rect class="sha-foot" x="141" y="124" width="11" height="8" rx="2.5"/>' +
      // padlock at lower-left
      '<rect class="sha-lock-body" x="26" y="84" width="28" height="24" rx="5"/>' +
      '<path class="sha-lock-shackle" d="M31.5 84v-4.5a8.5 8.5 0 0 1 17 0v4.5" stroke-width="3.4" stroke-linecap="round"/>' +
      '<circle class="sha-lock-hole" cx="40" cy="94" r="2.6"/>' +
      '<path class="sha-lock-hole-slot" d="M40 96v3" stroke-width="2.4" stroke-linecap="round"/>' +
      // glossy check-shield at right
      '<path class="sha-shield" d="M188 52l24 8v15c0 16-24 26-24 26s-24-10-24-26V60z" fill="url(#shaShield)"/>' +
      '<path class="sha-shield-gloss" d="M188 52l24 8v15c0 8-6 14-12 18-1-1-1-3 0-5 4-3 8-8 8-14V63l-20-6.5z"/>' +
      '<path class="sha-shield-check" d="M178 78l7.5 7.5 13-14" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      // sparkles
      '<path class="sha-spark" d="M170 34l1.7 4.3 4.3 1.7-4.3 1.7-1.7 4.3-1.7-4.3-4.3-1.7 4.3-1.7z"/>' +
      '<path class="sha-spark sha-spark-sm" d="M50 56l1.1 2.8 2.8 1.1-2.8 1.1-1.1 2.8-1.1-2.8-2.8-1.1 2.8-1.1z"/>' +
      '<path class="sha-spark sha-spark-sm" d="M210 106l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/>' +
    '</svg>';
  hero.append(heroText, heroArt);
  host.appendChild(hero);

  // ── Two-column body: setting cards (left) + reassurance panel (right) ──
  const grid = el("div", "settings-grid");
  const col = el("div", "settings-col");

  // Appearance (sun) — Switch theme (filled, brush icon) + current-theme pill.
  const themeBtn = el("button", "btn sm settings-action settings-theme-btn"); themeBtn.type = "button";
  const themeBtnIc = el("span", "settings-action-icon");
  themeBtnIc.setAttribute("aria-hidden", "true");
  themeBtnIc.innerHTML = SETTINGS_ICONS.brush;
  themeBtn.append(themeBtnIc, txt("span", null, "Switch theme"));
  const themeState = txt("span", "settings-theme-state", themeLabelText());
  themeState.setAttribute("aria-live", "polite");
  themeBtn.onclick = () => { cycleTheme(); themeState.textContent = themeLabelText(); };
  const themeCtrl = el("div", "settings-theme-ctrl");
  themeCtrl.appendChild(txt("span", "settings-theme-cap", "Current theme"));
  const themePill = el("div", "settings-theme-pill");
  themePill.appendChild(themeState);
  themeCtrl.appendChild(themePill);
  col.appendChild(settingsCard(
    "brand", "sun", "Appearance",
    "My Snowball follows your system light/dark setting by default. Cycle through light, dark, and follow-system here or from the toggle in the top bar.",
    [themeBtn, themeCtrl]
  ));

  // Data Vault (vault) — Back up + Restore from backup.
  const backupBtn = txt("button", "btn ghost sm settings-action", "Back up your data"); backupBtn.type = "button";
  backupBtn.onclick = () => exportVault();
  const restoreBtn = txt("button", "btn ghost sm settings-action", "Restore from backup"); restoreBtn.type = "button";
  restoreBtn.onclick = () => { const vi = $("#vaultFileInput"); if (vi) vi.click(); };
  const vaultCard = settingsCard(
    "green", "vault", "Data Vault",
    IS_NATIVE
      ? "Your debts and plan live only on this device. Back them up to a file you keep, and restore that file on any device — My Snowball never uploads anything."
      : "Your debts and plan live only in this browser. Back them up to a file you keep, and restore that file on any device — My Snowball never uploads anything.",
    [backupBtn, restoreBtn]
  );
  // Honest last-backup line: makes on-device data-loss defense visible.
  {
    const last = getLastBackup();
    const line = el("div", `vault-lastbackup${last ? "" : " is-never"}`);
    const dot = el("span", "vault-lastbackup-dot"); dot.setAttribute("aria-hidden", "true");
    line.appendChild(dot);
    line.appendChild(txt("span", null, last
      ? `Last backed up ${relTimeSince(last)}.`
      : "You haven't backed up on this device yet — save a copy so a cleared browser can't take your plan."));
    vaultCard.appendChild(line);
  }
  col.appendChild(vaultCard);

  // Snowball Pro (crown) — web: Restore with a code (+ license card if owned);
  // iOS: Apple's "Restore Purchases" only — no typed code and no license card on
  // native (Apple carries the entitlement across the buyer's devices). Web branch
  // is the exact existing copy/controls.
  let proControls, proBody;
  if (IS_NATIVE) {
    const nativeRestoreBtn = txt("button", "btn ghost sm settings-action", "Restore Purchases"); nativeRestoreBtn.type = "button";
    nativeRestoreBtn.onclick = async () => {
      const prev = nativeRestoreBtn.textContent;
      nativeRestoreBtn.disabled = true; nativeRestoreBtn.textContent = "Restoring…";
      let res;
      try { res = await Billing.restorePurchases(); }
      catch (e) { console.error("Snowball: restore threw", e); res = { ok: false }; }
      nativeRestoreBtn.disabled = false; nativeRestoreBtn.textContent = prev;
      if (res && res.ok) {
        announce("Welcome back — Pro is unlocked on this device.", false);
        showToast("Welcome back — Pro is unlocked on this device.");
        refreshAfterProChange();
        runPendingProIntent();
      } else {
        showToast("No previous purchase found for this Apple Account.");
      }
    };
    proControls = [nativeRestoreBtn];
    proBody = "Already bought Pro on another device? Tap Restore Purchases — it comes back on any device signed in with the same Apple Account.";
  } else {
    const restoreCodeBtn = txt("button", "btn ghost sm settings-action", "Restore with a code"); restoreCodeBtn.type = "button";
    restoreCodeBtn.onclick = () => showRestoreEntryModal();
    proControls = [restoreCodeBtn];
    if (Billing && typeof Billing.getRestoreCode === "function" && Billing.getRestoreCode()) {
      const cardBtn = txt("button", "btn ghost sm settings-action", "View your Pro license card"); cardBtn.type = "button";
      cardBtn.onclick = () => showLicenseCardModal();
      proControls.push(cardBtn);
    }
    proBody = "Already bought Pro on another device? My Snowball keeps no accounts, so unlock it here with the restore code you saved.";
  }
  col.appendChild(settingsCard(
    "violet", "crown", "My Snowball Pro",
    proBody,
    proControls
  ));

  // Data & privacy (shield) — blurb + honest checklist.
  // Platform-aware body: on iOS Pro is Apple In-App Purchase (never Stripe) and data
  // lives in the app's own storage, not "this browser". Web keeps the exact existing copy.
  const privCard = settingsCard(
    "amber", "shield", "Data & privacy",
    IS_NATIVE
      ? "Everything you enter — balances, rates, minimum payments, your strategy — is stored only on this device. There's no account and no server: nothing is uploaded, and the only time My Snowball touches the network is when you open the upgrade screen or confirm a Pro unlock through the App Store."
      : "Everything you enter — balances, rates, minimum payments, your strategy — is stored only in this browser's local storage on this device. There's no account and no server: nothing is uploaded, and the only time My Snowball touches the network is a secure Stripe checkout if you choose to buy Pro."
  );
  const checklist = el("div", "settings-checklist");
  // iOS shows Apple's localized price here (Apple charges the storefront price, not
  // always USD); web keeps the literal "$9.99". Falls back to "$9.99" until fetched.
  const checkPriceLine = (IS_NATIVE ? nativePriceOr("$9.99") : "$9.99") + " once — never a subscription";
  [
    "Stored only on this device",
    "No account, no uploads — ever",
    "No bank link · no ads · no tracking",
    checkPriceLine,
  ].forEach((label) => {
    const item = el("div", "settings-check");
    const ic = el("span", "settings-check-icon");
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = SETTINGS_ICONS.check;
    const labelEl = txt("span", null, label);
    // Tag the price line so a late-arriving Apple priceString swaps in live.
    if (IS_NATIVE && label === checkPriceLine) labelEl.setAttribute("data-native-price", "{price} once — never a subscription");
    item.append(ic, labelEl);
    checklist.appendChild(item);
  });
  privCard.appendChild(checklist);
  // Demonstrable-privacy line: the claim closed/cloud apps can't make.
  privCard.appendChild(txt("p", "settings-verify", IS_NATIVE
    ? "Want proof? Turn on Airplane Mode and use My Snowball — everything still works, because your data never depends on a server."
    : "Want proof? Open your browser's Network tab and use My Snowball — you'll see zero requests carrying your data."));
  col.appendChild(privCard);

  grid.appendChild(col);

  // Right-hand "Your data stays with you" reassurance panel.
  const aside = el("div", "panel data-assure");
  const head = el("div", "data-assure-head");
  const headIc = el("span", "data-assure-head-icon");
  headIc.setAttribute("aria-hidden", "true");
  headIc.innerHTML = SETTINGS_ICONS.shield;
  head.append(headIc, txt("span", "data-assure-head-title", "Your data stays with you"));
  aside.appendChild(head);
  aside.appendChild(dataAssureRow("brand", "lock", "Private by design", "No sign-ups, no accounts, no cloud."));
  aside.appendChild(dataAssureRow("violet", "cloudOff", "Local backups", "Back up to a file you decide. You own it."));
  aside.appendChild(dataAssureRow("green", "device", "Restore anywhere", "Use your backup file on any device, anytime."));
  aside.appendChild(dataAssureRow("amber", "peace", "Peace of mind", "Your financial data is always safe and private."));
  const tip = el("div", "data-assure-tip");
  const tipIc = el("span", "data-assure-tip-icon");
  tipIc.setAttribute("aria-hidden", "true");
  tipIc.innerHTML = SETTINGS_ICONS.tip;
  const tipText = el("p", "data-assure-tip-text");
  tipText.appendChild(txt("strong", null, "Tip: "));
  tipText.appendChild(document.createTextNode("Regularly back up your data to keep your plan safe."));
  tip.append(tipIc, tipText);
  aside.appendChild(tip);
  grid.appendChild(aside);

  host.appendChild(grid);
  return host;
}
// Human-readable current theme preference for the Settings state label.
function themeLabelText() {
  const pref = readThemePref();
  return "Current: " + (pref === "system" ? "follow system" : pref);
}

// ── Goal-seek panel ("be debt-free by [date]") ─────────────────────────────
// Free feature. Lets the user name a target month; on "Find" it binary-searches
// the extra monthly payment needed to hit it and shows the answer. It never
// touches state.extraPayment unless the user explicitly clicks "Apply".
function buildGoalSeekPanel() {
  const panel = el("div", "panel goal-seek");
  panel.appendChild(txt("h3", null, "Reach a debt-free date"));
  panel.appendChild(txt("p", "hint", "Pick when you want to be debt-free and My Snowball works out the extra you'd need each month."));

  const wrap = el("div", "field");
  const id = `f${++fieldIdSeq}`;
  const labelEl = txt("label", "field-label", "I want to be debt-free by");
  labelEl.htmlFor = id;
  wrap.appendChild(labelEl);
  const input = el("input");
  input.id = id;
  input.type = "month";
  // Sensible default floor: you can't be debt-free before next month.
  const now = new Date();
  input.min = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  wrap.appendChild(input);
  panel.appendChild(wrap);

  // 3-mini-feature row (mockup harvest) — reassurance under the date picker,
  // above the button. Purely presentational; all fixed developer SVG constants.
  const miniRow = el("div", "goal-mini-row");
  [
    ["calendar", "See your freedom date", "Know the exact date you'll be debt-free."],
    ["trend", "Smart calculations", "We'll figure the extra payment you need."],
    ["target", "Stay on track", "Adjust and explore what-if scenarios."],
  ].forEach(([iconKey, title, line]) => {
    const mini = el("div", "goal-mini");
    const ic = el("span", "goal-mini-icon");
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = PAYOFF_ICONS[iconKey] || "";
    const body = el("div");
    body.appendChild(txt("div", "goal-mini-title", title));
    body.appendChild(txt("div", "goal-mini-line", line));
    mini.append(ic, body);
    miniRow.appendChild(mini);
  });
  panel.appendChild(miniRow);

  const findBtn = txt("button", "btn ghost sm", "Find the payment"); findBtn.type = "button";
  panel.appendChild(findBtn);

  const resultHost = el("div", "goal-result");
  panel.appendChild(resultHost);

  const run = () => {
    resultHost.innerHTML = "";
    const activeDebts = planScopedDebts().filter((d) => d.balance > 0 && d.minPayment > 0);
    if (!activeDebts.length) {
      resultHost.appendChild(txt("p", "hint", "Add at least one debt with a balance and a minimum payment first."));
      return;
    }
    const targetMonths = targetMonthsFromValue(input.value);
    if (targetMonths == null || targetMonths < 1) {
      resultHost.appendChild(txt("p", "hint", "Pick a target month in the future."));
      return;
    }
    const dateLabel = formatDate(addMonths(new Date(), targetMonths));
    const res = goalSeekExtra(activeDebts, state.strategy, targetMonths);
    if (!res) {
      resultHost.appendChild(txt("p", "hint", "Add at least one debt with a balance and a minimum payment first."));
      return;
    }
    if (res.kind === "already") {
      resultHost.appendChild(txt("p", "goal-msg ok", `You're already on track to be debt-free by ${dateLabel} with no extra payment. Nice.`));
      return;
    }
    if (res.kind === "unreachable") {
      resultHost.appendChild(txt("p", "goal-msg", `Even ${money(res.cap)}/month extra wouldn't clear these debts by ${dateLabel} — that date may be too soon. Try a later month.`));
      return;
    }
    // kind === "found"
    resultHost.appendChild(txt("p", "goal-msg", `You'd need about ${money(res.extra)}/month extra to be debt-free by ${dateLabel}.`));
    const applyBtn = txt("button", "btn sm goal-apply", `Apply ${money(res.extra)}/mo extra`); applyBtn.type = "button";
    applyBtn.onclick = () => {
      state.extraPayment = safeNumber(res.extra, { min: 0, max: MAX_MONEY });
      scheduleSave();
      buildApp(); // reflects the new extra payment across the strategy field + results
    };
    resultHost.appendChild(applyBtn);
  };

  findBtn.onclick = run;
  // Enter in the month field runs the search too.
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  return panel;
}

// Smallest whole extra-payment/month that makes the whole plan actually pay off
// within the cap. Binary search over the pure simulator. Returns null if even a
// very large extra can't resolve it (pathological), else a rounded dollar figure.
function solveExtraToResolve(activeDebts, strategy) {
  if (!simulateStrategy(activeDebts, strategy, 0).neverPaysOff) return 0;
  const totalBal = activeDebts.reduce((s, d) => s + Math.max(0, safeNumber(d.balance, { min: 0, max: MAX_MONEY })), 0);
  let hi = 50;
  const ceilExtra = Math.max(1000, totalBal); // paying the whole balance each month always resolves
  while (hi < ceilExtra && simulateStrategy(activeDebts, strategy, hi).neverPaysOff) hi *= 2;
  if (simulateStrategy(activeDebts, strategy, hi).neverPaysOff) return null;
  let lo = hi / 2;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (simulateStrategy(activeDebts, strategy, mid).neverPaysOff) lo = mid; else hi = mid;
  }
  return Math.ceil(hi);
}
// Honest never-pays-off copy: don't just say "add an extra payment" — say how much.
function neverPaysOffMessage(activeDebts, strategy) {
  const base = `At this payment level, these debts don't pay off within ${CAP_MONTHS / 12} years.`;
  const need = solveExtraToResolve(activeDebts, strategy);
  if (need && need > 0) {
    const sim = simulateStrategy(activeDebts, strategy, need);
    if (!sim.neverPaysOff) {
      return `${base} Putting about ${money(need)}/month extra toward them would clear them — debt-free by ${formatDate(addMonths(new Date(), sim.months))}.`;
    }
  }
  return `${base} Increase your minimums or add an extra payment.`;
}
// Honest heads-up for federal student-loan borrowers: for anyone on an
// income-driven plan or headed for forgiveness/PSLF, "pay it off early" can be
// the WRONG move — those balances are forgiven, so extra payments are wasted.
// Snowball can't know a debt's plan, so it never fabricates numbers; it just
// flags the assumption once, conditionally, and points them to their servicer.
function buildStudentLoanAdvisory() {
  let ack; try { ack = localStorage.getItem(SL_ADVISORY_KEY) === "1"; } catch { ack = false; }
  if (ack) return null;
  const box = el("div", "sl-advisory");
  const ic = el("span", "sl-advisory-ic"); ic.setAttribute("aria-hidden", "true");
  ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5"/></svg>';
  box.appendChild(ic);
  const body = el("div", "sl-advisory-body");
  body.appendChild(txt("div", "sl-advisory-title", "A note on federal student loans"));
  body.appendChild(txt("div", "sl-advisory-msg", "If any of these are federal student loans on an income-driven plan or headed for forgiveness (like PSLF), paying them off early may not help you — My Snowball assumes early payoff is always a win. Worth checking with your servicer before you prioritize them."));
  box.appendChild(body);
  const dismiss = txt("button", "sl-advisory-dismiss", "Got it"); dismiss.type = "button";
  dismiss.onclick = () => { try { localStorage.setItem(SL_ADVISORY_KEY, "1"); } catch { /* private mode */ } buildApp(); };
  box.appendChild(dismiss);
  return box;
}
function debtWarning(debt) {
  if (debt.balance > 0 && debt.minPayment <= 0) {
    return warnBox("Add a minimum payment to include this debt in your plan.");
  }
  // A percent minimum always covers interest by construction, so this warning
  // only applies to a flat minimum that's smaller than the monthly interest.
  if (debt.balance > 0 && debt.minPayment > 0 && debt.minKind !== "percent") {
    const monthlyInterest = debt.balance * (debt.apr / 100 / 12);
    if (debt.minPayment < monthlyInterest) {
      return warnBox(`This minimum won't cover the ${moneyPrecise(monthlyInterest)}/month interest — the balance will grow unless this debt gets extra payments.`);
    }
  }
  return null;
}

function debtRow(debt, i) {
  const row = el("div", "debt-row");
  const top = el("div", "debt-top");
  top.appendChild(txt("span", "debt-label", `Debt ${i + 1}`));
  const acts = el("div", "debt-acts");
  // "Paid it off?" — celebrate + move it onto The Shelf. Available on any debt
  // (including your last one — that's the debt-free moment).
  const paid = el("button", "debt-paidoff", CELEBRATE_SVG + "<span>Paid off</span>");
  paid.type = "button";
  const pName = (debt.name || "").trim();
  paid.setAttribute("aria-label", pName ? `Mark ${pName} paid off and add it to your shelf` : `Mark debt ${i + 1} paid off`);
  paid.onclick = () => markDebtPaidOff(i);
  acts.appendChild(paid);
  if (state.debts.length > 1) {
    const rm = txt("button", "rm-debt", "Remove");
    rm.type = "button";
    // Name-aware label so screen-reader users know which debt this removes.
    const rmName = (debt.name || "").trim();
    rm.setAttribute("aria-label", rmName ? `Remove ${rmName}` : `Remove debt ${i + 1}`);
    rm.onclick = () => {
      const removed = state.debts[i];
      const nm = (removed && removed.name || "").trim();
      state.debts.splice(i, 1); scheduleSave(); buildApp();
      announce(nm ? `Removed ${nm}.` : "Debt removed.", false);
      showToast(nm ? `Removed ${nm}` : "Debt removed", "Undo", () => {
        state.debts.splice(Math.min(i, state.debts.length), 0, removed);
        scheduleSave(); buildApp();
        announce(nm ? `Restored ${nm}.` : "Debt restored.", false);
      });
    };
    acts.appendChild(rm);
  }
  top.appendChild(acts);
  row.appendChild(top);
  row.appendChild(field("Name", debt.name, (v) => { debt.name = v; refreshLive(); }, { placeholder: "e.g. Visa card" }));

  // The warning box is a stable, targeted node updated in place on every
  // relevant keystroke, instead of the whole row being torn down — a full
  // rebuild here would also cost the input its focus mid-type.
  const warnHost = el("div");
  const updateWarn = () => {
    warnHost.innerHTML = "";
    const w = debtWarning(debt);
    if (w) warnHost.appendChild(w);
  };

  const fr = el("div", "field-row");
  fr.appendChild(field("Balance", debt.balance || "", (v) => { debt.balance = safeNumber(v, { min: 0, max: MAX_MONEY }); updateWarn(); refreshLive(); }, { numeric: true, placeholder: "0", min: 0, max: MAX_MONEY }));
  fr.appendChild(field("APR %", debt.apr || "", (v) => { debt.apr = safeNumber(v, { min: 0, max: MAX_APR }); updateWarn(); refreshLive(); }, { numeric: true, placeholder: "0", min: 0, max: MAX_APR }));
  fr.appendChild(field("Min. payment", debt.minPayment || "", (v) => { debt.minPayment = safeNumber(v, { min: 0, max: MAX_MONEY }); updateWarn(); refreshLive(); }, { numeric: true, placeholder: "0", min: 0, max: MAX_MONEY }));
  row.appendChild(fr);

  updateWarn();
  row.appendChild(warnHost);
  row.appendChild(buildMinKindControl(debt));
  row.appendChild(buildPromoInput(debt));
  return row;
}
// Opt-in per debt: model a shrinking, credit-card-style minimum (% of balance +
// interest, floored at the entered minimum) instead of a flat one. Makes the
// plan — and especially the Minimum-Payment Trap X-Ray — reflect reality.
function buildMinKindControl(debt) {
  const wrap = el("div", "debt-minkind");
  const label = el("label", "debt-minkind-toggle");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = debt.minKind === "percent";
  cb.onchange = () => {
    if (cb.checked) {
      debt.minKind = "percent";
      // Calibrate the % from the user's OWN minimum + balance (e.g. $100 on
      // $5,000 = 2%), so it starts where they are today and shrinks from there.
      if (!(safeNumber(debt.minPercent, { min: 0, max: 100 }) > 0)) {
        const bal = safeNumber(debt.balance, { min: 0, max: MAX_MONEY });
        const mn = safeNumber(debt.minPayment, { min: 0, max: MAX_MONEY });
        debt.minPercent = (bal > 0 && mn > 0) ? Math.round((mn / bal) * 1000) / 10 : 2;
      }
    } else debt.minKind = "fixed";
    persistNow(); buildApp();
  };
  label.appendChild(cb);
  label.appendChild(txt("span", "debt-minkind-label", "Minimum shrinks as I pay it down (credit-card style)"));
  wrap.appendChild(label);
  if (debt.minKind === "percent") {
    const row = el("div", "debt-minkind-row");
    row.appendChild(txt("span", "debt-minkind-hint", "About"));
    const inWrap = el("span", "debt-minkind-inwrap");
    const inp = el("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.className = "debt-minkind-pct";
    inp.value = String(safeNumber(debt.minPercent, { min: 0, max: 100 }) || 2);
    inp.setAttribute("aria-label", "Minimum percent of balance");
    inp.oninput = () => { debt.minPercent = safeNumber(inp.value, { min: 0, max: 100 }); scheduleSave(); refreshLive(); };
    inWrap.appendChild(inp);
    inWrap.appendChild(txt("span", "debt-minkind-pctsign", "%"));
    row.appendChild(inWrap);
    row.appendChild(txt("span", "debt-minkind-hint", "of the balance each month, never below $25."));
    wrap.appendChild(row);
  }
  return wrap;
}
function warnBox(msg) {
  const box = el("div", "debt-warn");
  box.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 2.5 18a1.5 1.5 0 0 0 1.3 2.2h16.4a1.5 1.5 0 0 0 1.3-2.2L13.7 3.9a1.5 1.5 0 0 0-2.6 0Z"/></svg>';
  box.appendChild(document.createTextNode(msg));
  return box;
}

// ── Friendly empty-state block (illustration + warm framing) ──────────────
// Purely presentational: an inline brand SVG (fixed developer constant, safe
// innerHTML) above a heading and message. `heading`/`msg` are always
// textContent, so no user data is ever interpolated into markup.
// Clipboard-checklist motif (mockup) — used for the Payoff empty state so it
// reads as "a plan waiting to be filled in". Fixed developer SVG constant.
const EMPTY_ART_CLIPBOARD =
  '<svg viewBox="0 0 96 96" fill="none" aria-hidden="true">' +
    '<circle class="es-halo" cx="48" cy="48" r="46"/>' +
    '<rect class="es-clip-board" x="26" y="20" width="44" height="58" rx="6"/>' +
    '<rect class="es-clip-clip" x="40" y="14" width="16" height="10" rx="3"/>' +
    '<path class="es-clip-check" d="M34 38l3 3 5-6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path class="es-clip-check" d="M34 52l3 3 5-6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path class="es-clip-line" d="M48 40h14M48 54h14M48 67h10" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path class="es-spark" d="M74 26v7M70.5 29.5h7" stroke-width="2.4" stroke-linecap="round"/>' +
  '</svg>';
function emptyStateBlock(heading, msg, variant) {
  const wrap = el("div", "empty-state");
  const art = el("div", "empty-state-art");
  // A small snowball-on-a-slope motif — on-brand, hopeful, matches the
  // motivational summit card's visual language, drawn with currentColor tints.
  // The "clipboard" variant swaps to a checklist illustration (Payoff mockup).
  art.innerHTML = variant === "clipboard" ? EMPTY_ART_CLIPBOARD :
    '<svg viewBox="0 0 96 96" fill="none" aria-hidden="true">' +
      '<circle class="es-halo" cx="48" cy="48" r="46"/>' +
      '<path class="es-slope" d="M8 74 Q40 70 60 56 Q76 45 90 30" stroke-width="3" stroke-linecap="round"/>' +
      '<circle class="es-ball" cx="30" cy="66" r="13"/>' +
      '<circle class="es-ball-shine" cx="26" cy="61" r="4"/>' +
      '<path class="es-spark" d="M72 24 v8 M68 28 h8" stroke-width="2.4" stroke-linecap="round"/>' +
    '</svg>';
  wrap.appendChild(art);
  wrap.appendChild(txt("p", "empty-state-title", heading));
  wrap.appendChild(txt("p", "empty-state-msg", msg));
  return wrap;
}

// ── Summary stat-icon tiles (mockup card language) ─────────────────────────
// A small tinted-icon tile + value + label. The icon is a fixed developer SVG
// constant (safe innerHTML); `value` and `label` are always textContent.
// `tone` selects one of the tinted tiles authored in styles.css (all tokened,
// both themes). Icons are inline paths — no external assets, no network.
const STAT_ICONS = {
  debt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/></svg>',
  apr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 7-8"/><path d="M14 7h6v6"/></svg>',
  date: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>',
  pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.2c0-1 .9-1.7 2.5-1.7s2.5.7 2.5 1.7-1 1.5-2.5 1.8-2.5.8-2.5 1.8.9 1.7 2.5 1.7 2.5-.7 2.5-1.7"/></svg>',
  interest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/><path d="M5 19L19 5"/></svg>',
};
// Small inline-SVG glyphs shown next to panel titles (mockup section-header
// icons). Fixed developer constants (safe innerHTML), tinted on the brand ramp
// via .panel-title-icon. All decorative — the text label carries the meaning,
// so the icon host is aria-hidden.
const PANEL_ICONS = {
  strategy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1"/></svg>',
  debts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/><path d="M3 7v10a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="13.5" r="1.3"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3.5-4.5L14 13l4-6"/></svg>',
};
// Builds a panel <h3> with a leading brand-tinted icon chip + the title text.
// Returns the same <h3> the plain title calls produced, so all existing
// .panel h3 layout/spacing rules still apply. `text` is always textContent.
function panelTitle(text, iconKey) {
  const h = el("h3");
  const label = el("span", "panel-title-label");
  if (iconKey && PANEL_ICONS[iconKey]) {
    const ic = el("span", "panel-title-icon");
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = PANEL_ICONS[iconKey];
    label.appendChild(ic);
  }
  label.appendChild(txt("span", "panel-title-text", text));
  h.appendChild(label);
  return h;
}

function summaryTile(tone, iconKey, value, label) {
  const tile = el("div", `sum-tile tone-${tone}`);
  const ic = el("span", "sum-tile-icon");
  ic.innerHTML = STAT_ICONS[iconKey] || "";
  ic.setAttribute("aria-hidden", "true");
  const body = el("div", "sum-tile-body");
  body.appendChild(txt("div", "sum-tile-value", value));
  body.appendChild(txt("div", "sum-tile-label", label));
  tile.append(ic, body);
  return tile;
}

// ── Debt-free progress ring (projected, honest — NEVER "% paid") ───────────
// A stateless planner has no start date, so a "% elapsed / % paid" gauge would
// always read 0% — demoralizing and useless. This ring instead shows an honest,
// always-meaningful metric derived from the existing sim, and RISES as extra
// payments cut interest, so watching it climb rewards the plan. Generic gauge:
// caller supplies the pct + the labels. Pure inline SVG, --brand tokens, visible
// track both themes, role=img + aria-label + a text equivalent, reduced-motion.
function buildProgressRing(pct, bigText, subText, noteText, ariaLabel) {
  pct = Math.min(100, Math.max(0, Math.round(pct)));
  const R = 52, C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;
  const wrap = el("div", "progress-ring");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", ariaLabel);
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const svg =
    `<svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">` +
      `<circle class="ring-track" cx="64" cy="64" r="${R}" fill="none" stroke-width="12"/>` +
      `<circle class="ring-fill${reduce ? " no-anim" : ""}" cx="64" cy="64" r="${R}" fill="none" stroke-width="12" ` +
        `stroke-linecap="round" transform="rotate(-90 64 64)" ` +
        `stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}"/>` +
    `</svg>`;
  const gauge = el("div", "progress-ring-gauge");
  gauge.innerHTML = svg;
  const center = el("div", "progress-ring-center");
  center.appendChild(txt("div", "progress-ring-pct", bigText));
  center.appendChild(txt("div", "progress-ring-sub", subText));
  gauge.appendChild(center);
  wrap.appendChild(gauge);
  // Visible text equivalent (status not by color/graphic alone).
  wrap.appendChild(txt("p", "progress-ring-note", noteText));
  return wrap;
}

// ── Payment-breakdown donut (minimum payments vs extra) ────────────────────
// Vanilla inline SVG donut. Derivable from known totals: sum of minimums vs the
// extra payment. role=img + aria-label with the values; the legend below uses
// icon + text (a shape glyph, not color alone). Both themes via tokened stroke
// classes. When extra is 0 the donut is a single full min-payments ring.
function buildBreakdownDonut(totalMin, extra) {
  const total = totalMin + extra;
  const wrap = el("div", "donut-wrap");
  const R = 52, C = 2 * Math.PI * R;
  const minFrac = total > 0 ? totalMin / total : 1;
  const minLen = minFrac * C;
  const extraLen = C - minLen;
  const pctMin = Math.round(minFrac * 100);
  const pctExtra = 100 - pctMin;
  const label = `Payment breakdown donut. Minimum payments ${money(totalMin)} (${pctMin} percent), extra payment ${money(extra)} (${pctExtra} percent), total ${money(total)} per month.`;
  const chart = el("div", "donut-chart");
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", label);
  // The extra arc starts where the min arc ends (offset by minLen), both
  // rotated -90deg so the ring begins at 12 o'clock.
  const svg =
    `<svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">` +
      `<circle class="donut-bg" cx="64" cy="64" r="${R}" fill="none" stroke-width="16"/>` +
      `<circle class="donut-min" cx="64" cy="64" r="${R}" fill="none" stroke-width="16" ` +
        `transform="rotate(-90 64 64)" stroke-dasharray="${minLen.toFixed(2)} ${(C - minLen).toFixed(2)}"/>` +
      (extra > 0
        ? `<circle class="donut-extra" cx="64" cy="64" r="${R}" fill="none" stroke-width="16" ` +
          `transform="rotate(-90 64 64)" stroke-dasharray="${extraLen.toFixed(2)} ${(C - extraLen).toFixed(2)}" ` +
          `stroke-dashoffset="${(-minLen).toFixed(2)}"/>`
        : "") +
    `</svg>`;
  const center = el("div", "donut-center");
  center.appendChild(txt("div", "donut-center-val", money(total)));
  center.appendChild(txt("div", "donut-center-sub", "per month"));
  chart.innerHTML = svg;
  chart.appendChild(center);
  wrap.appendChild(chart);
  // Legend — icon(shape)+text+value, never color alone.
  const legend = el("div", "donut-legend");
  const legRow = (cls, glyph, name, value) => {
    const row = el("div", "donut-leg-item");
    const g = el("span", `donut-leg-glyph ${cls}`);
    g.textContent = glyph; g.setAttribute("aria-hidden", "true");
    row.appendChild(g);
    row.appendChild(txt("span", "donut-leg-name", name));
    row.appendChild(txt("span", "donut-leg-val", value));
    legend.appendChild(row);
  };
  legRow("is-min", "●", "Minimum payments", money(totalMin));
  legRow("is-extra", "◆", "Extra payment", money(extra));
  wrap.appendChild(legend);
  return wrap;
}

// ── Motivational card (one tasteful, on-brand encouragement) ───────────────
// Snow/summit metaphor fitting "Snowball". Warm, non-pushy copy (this buyer is
// often financially stressed). Inline tokened SVG + a dark variant via CSS.
// ── Promo-APR Cliff Guard (Pro) ─────────────────────────────────────────────
// Optional per-debt intro-rate terms (0%/low rate that expires). The simulator
// already models the rate jump; this surfaces whether each promo clears in time
// and what it takes to beat the cliff — with a hard warning on deferred interest.
function monthsToCliff(promo) {
  if (!promo || !promo.endMonth) return null;
  return monthKeyNum(promo.endMonth) - monthKeyNum(currentMonthKey());
}
function addPromoToDebt(debt) {
  const d = new Date(), end = new Date(d.getFullYear(), d.getMonth() + 12, 1);
  debt.promo = { endMonth: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}`, postApr: 24.99, deferred: false };
  scheduleSave(); buildApp();
}
function removePromoFromDebt(debt) { debt.promo = null; scheduleSave(); buildApp(); }
// Level monthly payment to clear `balance` in `months` at `monthlyRate` (0% -> B/N).
function paymentToClear(balance, monthlyRate, months) {
  if (months <= 0) return balance;
  if (monthlyRate <= 1e-7) return balance / months;
  return balance * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
}
function buildPromoInput(debt) {
  let isPro = false; try { isPro = Billing.isPro(); } catch (e) { isPro = false; }
  const wrap = el("div", "debt-promo");
  // Free users (INCLUDING those who imported a backup carrying promo data) only
  // ever get the gated add button — never the editable promo terms. Editing promo
  // terms is the Pro capability, so an imported promo can't be edited for free.
  if (!isPro || !debt.promo) {
    const add = txt("button", "debt-promo-add", "＋ 0% / intro-rate deadline?");
    add.type = "button";
    add.onclick = () => gateProAction(add, { reason: "promoGuard" }, () => addPromoToDebt(debt));
    wrap.appendChild(add);
    return wrap;
  }
  const head = el("div", "debt-promo-head");
  head.appendChild(txt("span", "debt-promo-title", "Intro / 0% rate"));
  const rm = txt("button", "debt-promo-remove", "Remove"); rm.type = "button";
  rm.onclick = () => removePromoFromDebt(debt);
  head.appendChild(rm);
  wrap.appendChild(head);

  const grid = el("div", "debt-promo-grid");
  const mWrap = el("div", "field");
  const mId = `f${++fieldIdSeq}`;
  const mLab = txt("label", "field-label", "Rate ends"); mLab.htmlFor = mId; mWrap.appendChild(mLab);
  const mIn = el("input"); mIn.id = mId; mIn.type = "month"; mIn.value = debt.promo.endMonth;
  const now = new Date(); mIn.min = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  mIn.onchange = () => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(mIn.value)) { debt.promo.endMonth = mIn.value; scheduleSave(); refreshLive(); } };
  mWrap.appendChild(mIn); grid.appendChild(mWrap);
  const rWrap = el("div", "field");
  const rId = `f${++fieldIdSeq}`;
  const rLab = txt("label", "field-label", "Rate after %"); rLab.htmlFor = rId; rWrap.appendChild(rLab);
  const rIn = el("input"); rIn.id = rId; rIn.type = "text"; rIn.inputMode = "decimal"; rIn.value = debt.promo.postApr || "";
  rIn.setAttribute("aria-label", "Rate after the promo ends");
  rIn.oninput = () => { debt.promo.postApr = safeNumber(rIn.value, { min: 0, max: MAX_APR }); scheduleSave(); refreshLive(); };
  rWrap.appendChild(rIn); grid.appendChild(rWrap);
  wrap.appendChild(grid);

  const defLabel = el("label", "debt-promo-deferred");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = !!debt.promo.deferred;
  cb.onchange = () => { debt.promo.deferred = cb.checked; scheduleSave(); refreshLive(); };
  defLabel.appendChild(cb);
  defLabel.appendChild(txt("span", "debt-promo-deflabel", "Deferred interest (back-charges if not cleared in time)"));
  wrap.appendChild(defLabel);
  return wrap;
}
function buildPromoCliffCard(activeDebts, strategy, extra) {
  // Pro-only analysis card — never rendered for a free user, even if imported
  // backup data carries a promo debt.
  let isPro = false; try { isPro = Billing.isPro(); } catch (e) { isPro = false; }
  if (!isPro) return null;
  const promoDebts = activeDebts.filter((d) => d.promo && d.promo.endMonth);
  if (!promoDebts.length) return null;
  const sim = simulateStrategy(activeDebts, strategy, extra, { trackPerDebt: true });
  const card = el("div", "panel promo-cliff-card");
  card.appendChild(txt("h3", null, "Promo-rate cliff guard"));
  card.appendChild(txt("p", "hint", "Intro 0% / low rates expire. Here's whether each one clears in time — and what it takes to beat the cliff."));

  promoDebts.forEach((d) => {
    const name = (d.name || "").trim() || "This debt";
    const cliff = monthsToCliff(d.promo);
    const postApr = Math.max(0, d.promo.postApr || 0);
    const bal = safeNumber(d.balance, { min: 0, max: MAX_MONEY });
    let atCliff = bal;
    if (cliff > 0 && sim.series && sim.series[d.id]) {
      const arr = sim.series[d.id];
      atCliff = arr[Math.max(0, Math.min(arr.length - 1, cliff))] || 0;
    }
    const row = el("div", "promo-cliff-row");
    if (cliff <= 0) {
      row.classList.add("pc-bad");
      row.appendChild(txt("div", "pc-name", name));
      row.appendChild(txt("div", "pc-msg", `The intro rate has ended — about ${money(bal)} is now accruing ${postApr}%. Prioritize it.`));
    } else if (atCliff <= 0.5) {
      row.classList.add("pc-good");
      row.appendChild(txt("div", "pc-name", `${name} — on track ✓`));
      row.appendChild(txt("div", "pc-msg", `You'll clear it before the ${postApr}% kicks in (${monthKeyLabel(d.promo.endMonth)}). Nice work.`));
    } else {
      row.classList.add("pc-bad");
      const needed = paymentToClear(bal, d.apr / 100 / 12, cliff);
      const extraVsMin = Math.max(0, needed - safeNumber(d.minPayment, { min: 0, max: MAX_MONEY }));
      row.appendChild(txt("div", "pc-name", name));
      const m = el("div", "pc-msg");
      m.appendChild(document.createTextNode("About "));
      const b1 = el("b"); b1.textContent = money(atCliff); m.appendChild(b1);
      m.appendChild(document.createTextNode(` will still be owed when the rate jumps to ${postApr}% in ${monthKeyLabel(d.promo.endMonth)}. Pay about `));
      const b2 = el("b"); b2.textContent = money(needed) + "/mo"; m.appendChild(b2);
      m.appendChild(document.createTextNode(" on it to clear it in time"));
      if (extraVsMin > 0.5) m.appendChild(document.createTextNode(` (${money(extraVsMin)} above its minimum)`));
      m.appendChild(document.createTextNode("."));
      row.appendChild(m);
      if (d.promo.deferred) row.appendChild(txt("div", "pc-deferred", "⚠ Deferred-interest offer: if it isn't cleared in time, all the interest it's been holding back is charged at once. Beating this cliff is critical."));
    }
    card.appendChild(row);
  });
  return card;
}

// ── Reward photo (Pro) — your goal image, revealed as you really pay down ────
// Reveal is driven by the REAL ledger (principal actually paid) + conquered debts,
// never a projection, so it can't lie. The photo is downscaled and stored only on
// this device. Pure on-device canvas; nothing is ever uploaded.
function rewardProgressFraction() {
  const ledger = Array.isArray(state.ledger) ? state.ledger : [];
  let paid = 0;
  ledger.forEach((entry) => entry.entries.forEach((x) => {
    paid += Math.max(0, safeNumber(x.before, { min: 0, max: MAX_MONEY }) - safeNumber(x.after, { min: 0, max: MAX_MONEY }));
  }));
  const closedPaid = (Array.isArray(state.closedDebts) ? state.closedDebts : []).reduce((s, c) => s + Math.max(0, safeNumber(c.amount, { min: 0, max: MAX_MONEY })), 0);
  const bal = (Array.isArray(state.debts) ? state.debts : []).reduce((s, d) => s + Math.max(0, safeNumber(d.balance, { min: 0, max: MAX_MONEY })), 0);
  const paidTotal = paid + closedPaid;
  const denom = paidTotal + bal;
  if (denom <= 0) return 0;
  return Math.max(0, Math.min(1, paidTotal / denom));
}
function loadRewardPhoto(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 720;
      let w = img.width, h = img.height;
      if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      try { setRewardPhoto(cv.toDataURL("image/jpeg", 0.82)); } catch (e) { announce("That photo is too large to store on this device — try a smaller one.", true); return; }
      buildApp();
    };
    img.onerror = () => announce("Couldn't read that image — try another.", true);
    img.src = reader.result;
  };
  reader.onerror = () => announce("Couldn't read that file.", true);
  reader.readAsDataURL(file);
}
function drawReward(canvas, img, frac) {
  const W = canvas.width = Math.max(200, canvas.clientWidth || 320);
  const H = canvas.height = Math.round(W * 0.6);
  const ctx = canvas.getContext("2d");
  const ir = img.width / img.height, cr = W / H;
  let dw, dh, dx, dy;
  if (ir > cr) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0; } else { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2; }
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(img, dx, dy, dw, dh);
  // Frost the not-yet-earned (top) portion; it recedes downward as progress grows.
  const coverH = Math.round((1 - Math.max(0, Math.min(1, frac))) * H);
  if (coverH > 0) {
    ctx.fillStyle = "rgba(228,241,246,0.94)";
    ctx.fillRect(0, 0, W, coverH);
    const grad = ctx.createLinearGradient(0, Math.max(0, coverH - 26), 0, coverH);
    grad.addColorStop(0, "rgba(228,241,246,0.94)"); grad.addColorStop(1, "rgba(228,241,246,0)");
    ctx.fillStyle = grad; ctx.fillRect(0, Math.max(0, coverH - 26), W, 26);
  }
}
function buildRewardPhotoCard() {
  let isPro = false; try { isPro = Billing.isPro(); } catch (e) { isPro = false; }
  const card = el("div", "panel reward-card");
  card.appendChild(txt("h3", null, "Your why"));
  if (!isPro) {
    card.appendChild(txt("p", "hint", "Pick a photo of what you're working toward — a trip, a paid-off home, your kid — and watch it reappear as your balances fall."));
    const teaser = el("div", "reward-teaser");
    teaser.appendChild(txt("span", "reward-teaser-emoji", "🖼️"));
    teaser.appendChild(txt("span", "reward-teaser-text", "Unlocks with Pro — your photo never leaves your device."));
    card.appendChild(teaser);
    const btn = txt("button", "btn brand sm", "Unlock Pro"); btn.type = "button";
    btn.onclick = () => showProModal({ reason: "rewardPhoto" });
    card.appendChild(btn);
    return card;
  }
  const photo = getRewardPhoto();
  const fileInput = () => { const i = el("input"); i.type = "file"; i.accept = "image/*"; i.style.display = "none"; i.onchange = () => { const f = i.files && i.files[0]; if (f) loadRewardPhoto(f); }; return i; };
  if (!photo) {
    card.appendChild(txt("p", "hint", "Pick a photo of your goal — it reappears as you pay down, and never leaves this device."));
    const inp = fileInput();
    const pick = txt("button", "btn brand sm", "Choose a photo"); pick.type = "button";
    pick.onclick = () => inp.click();
    card.append(pick, inp);
    return card;
  }
  const frac = rewardProgressFraction();
  const wrap = el("div", "reward-canvas-wrap");
  const canvas = el("canvas"); canvas.className = "reward-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Your goal photo, ${Math.round(frac * 100)}% revealed as you pay down.`);
  wrap.appendChild(canvas);
  card.appendChild(wrap);
  card.appendChild(txt("p", "reward-progress", frac >= 0.999 ? "Fully revealed — you did it. 🎉" : `${Math.round(frac * 100)}% revealed — every payment brings it back.`));
  const acts = el("div", "reward-acts");
  const inp = fileInput();
  const change = txt("button", "reward-link", "Change photo"); change.type = "button"; change.onclick = () => inp.click();
  const remove = txt("button", "reward-link", "Remove"); remove.type = "button"; remove.onclick = () => { clearRewardPhoto(); buildApp(); };
  acts.append(change, remove);
  card.append(acts, inp);
  const img = new Image();
  img.onload = () => drawReward(canvas, img, frac);
  img.src = photo;
  return card;
}

// ── Year in Review — the progress story (Pro) ───────────────────────────────
// A Wrapped-style summary from the check-in history + the Shelf: months logged,
// longest streak, debts conquered, monthly cash freed, plus an honest closing
// projection. Free sees a teaser + upsell; Pro sees the full story. Only appears
// once there's a story to tell (>=1 check-in OR >=1 conquered debt).
function longestStreak(checkins) {
  if (!checkins || !checkins.length) return 0;
  const sorted = [...checkins].sort();
  let best = 1, cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (monthKeyNum(sorted[i]) - monthKeyNum(sorted[i - 1]) === 1) { cur++; best = Math.max(best, cur); }
    else cur = 1;
  }
  return best;
}
function buildYearInReviewCard(active, plan) {
  const checkins = Array.isArray(state.checkins) ? state.checkins : [];
  const closed = Array.isArray(state.closedDebts) ? state.closedDebts : [];
  if (checkins.length < 1 && closed.length < 1) return null;

  let isPro = false;
  try { isPro = Billing.isPro(); } catch (e) { isPro = false; }

  const card = el("div", "panel yir-card");
  card.appendChild(txt("h3", null, "Your payoff story"));

  if (!isPro) {
    card.appendChild(txt("p", "hint", "Unlock Pro to see your full progress story — months logged, your longest streak, every debt you've conquered, and the monthly cash you've freed up."));
    const btn = txt("button", "btn sm", "Unlock Pro to see your story"); btn.type = "button";
    btn.onclick = () => gateProAction(btn, { reason: "yearInReview" }, () => buildApp());
    card.appendChild(btn);
    return card;
  }

  const total = checkins.length;
  const best = longestStreak(checkins);
  const conquered = closed.length;
  const freed = closed.reduce((s, c) => s + (c.freedPerMonth || 0), 0);

  const stats = el("div", "yir-stats");
  const stat = (v, l) => { const b = el("div", "yir-stat"); b.appendChild(txt("div", "yir-stat-val", v)); b.appendChild(txt("div", "yir-stat-lab", l)); return b; };
  if (total > 0) stats.appendChild(stat(String(total), total === 1 ? "month logged" : "months logged"));
  if (best > 1) stats.appendChild(stat(`${best} 🔥`, "longest streak"));
  if (conquered > 0) stats.appendChild(stat(String(conquered), conquered === 1 ? "debt conquered" : "debts conquered"));
  if (freed > 0) stats.appendChild(stat(money(freed) + "/mo", "freed up"));
  card.appendChild(stats);

  if (plan && !plan.neverPaysOff && plan.months > 0) {
    card.appendChild(txt("p", "yir-close", `Keep it up — at your current plan, you're debt-free by ${formatDate(addMonths(new Date(), plan.months))}.`));
  } else if (conquered > 0) {
    card.appendChild(txt("p", "yir-close", "Look how far you've come. Every one of these was a win worth keeping."));
  }
  return card;
}

// ── The Shelf — conquered-debt trophies (free) ──────────────────────────────
// Paid-off debts don't vanish; each becomes a frosted snow-globe trophy with the
// name, the monthly payment it freed up, an optional note, and the month cleared.
// The identity-shift "look what I've conquered" surface. Opt-in; vault-safe.
function buildTrophy(c) {
  const card = el("div", "trophy");
  const globe = el("div", "trophy-globe");
  globe.setAttribute("aria-hidden", "true");
  globe.innerHTML =
    '<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<ellipse class="tg-shadow" cx="24" cy="43" rx="12" ry="2.6"/>' +
      '<rect class="tg-stand" x="15" y="35.5" width="18" height="6" rx="2.2"/>' +
      '<circle class="tg-glass" cx="24" cy="21" r="15"/>' +
      '<path class="tg-snowmound" d="M10.5 27 Q24 21 37.5 27 L37.5 33 Q24 27 10.5 33 Z"/>' +
      '<path class="tg-check" d="M17.5 21.5 l4.2 4.4 8.8 -10" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle class="tg-flake" cx="15" cy="15" r="1.1"/><circle class="tg-flake" cx="33" cy="14" r="1.1"/><circle class="tg-flake" cx="30" cy="24" r="1"/>' +
    '</svg>';
  card.appendChild(globe);
  card.appendChild(txt("div", "trophy-name", (c.name || "").trim() || "A debt"));
  const meta = el("div", "trophy-meta");
  meta.appendChild(txt("div", "trophy-line", `Paid off · ${monthKeyLabel(c.closedAt)}`));
  if (c.freedPerMonth > 0) meta.appendChild(txt("div", "trophy-freed-line", `Freed up ${money(c.freedPerMonth)}/mo`));
  card.appendChild(meta);
  const note = el("input", "trophy-note");
  note.type = "text"; note.value = c.note || ""; note.placeholder = "Add a note…"; note.maxLength = 280;
  note.setAttribute("aria-label", `Note for ${(c.name || "").trim() || "this trophy"}`);
  note.oninput = () => { c.note = note.value; scheduleSave(); }; // save-only, never rebuild (keeps caret)
  card.appendChild(note);
  const rm = txt("button", "trophy-remove", "×"); rm.type = "button";
  rm.setAttribute("aria-label", `Remove ${(c.name || "").trim() || "trophy"} from your shelf`);
  rm.onclick = () => removeFromShelf(c.id);
  card.appendChild(rm);
  return card;
}
function buildShelfSection() {
  const closed = Array.isArray(state.closedDebts) ? state.closedDebts : [];
  if (!closed.length) return null;
  const panel = el("div", "panel shelf-panel");
  const head = el("div", "shelf-head");
  head.appendChild(txt("h3", null, "Conquered"));
  const freedTotal = closed.reduce((s, c) => s + (c.freedPerMonth || 0), 0);
  if (freedTotal > 0) head.appendChild(txt("span", "shelf-freed", `Freed up ${money(freedTotal)}/mo`));
  panel.appendChild(head);
  const grid = el("div", "shelf-grid");
  [...closed].reverse().forEach((c) => grid.appendChild(buildTrophy(c))); // newest first
  panel.appendChild(grid);
  return panel;
}

// ── Snowpack: monthly payment check-in (free) ───────────────────────────────
// The come-back-every-month hook. One tap logs "I made this month's payments"
// into an opt-in, private list — which yields an honest progress bar (months
// logged vs the projected remaining), a forgiving streak, and a growing record.
// Only shown when there's an active plan to make payments against.
function buildSnowpackCard(active, plan) {
  if (!active || !active.length) return null;
  const checkins = Array.isArray(state.checkins) ? state.checkins : [];
  const thisMonth = currentMonthKey();
  const loggedThisMonth = checkins.includes(thisMonth);
  const total = checkins.length;
  const streak = checkinStreak(checkins);
  const remaining = (plan && !plan.neverPaysOff && plan.months > 0) ? plan.months : null;

  const card = el("div", "panel snowpack-card");
  const head = el("div", "snowpack-head");
  head.appendChild(txt("h3", null, "Your snowpack"));
  if (streak > 1) head.appendChild(txt("span", "snowpack-streak", `🔥 ${streak} in a row`));
  card.appendChild(head);

  if (total === 0) {
    card.appendChild(txt("p", "hint", "Log what you pay each month — your balances update, your debt-free date re-projects, and you build a private record of real progress. It all stays on your device."));
  } else {
    if (remaining != null) {
      const totalJourney = total + remaining;
      const pct = totalJourney > 0 ? Math.max(3, Math.min(99, Math.round((total / totalJourney) * 100))) : 0;
      const bar = el("div", "snowpack-bar");
      const fill = el("div", "snowpack-fill"); fill.style.width = pct + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    const stats = el("p", "snowpack-stats");
    const b = el("b"); b.textContent = `${total} month${total === 1 ? "" : "s"} logged`;
    stats.appendChild(b);
    if (remaining != null) stats.appendChild(document.createTextNode(` · about ${monthsLabel(remaining)} to go`));
    card.appendChild(stats);
  }

  // "Why your target changed" note, shown once right after a log.
  if (lastRerankNote) {
    const note = el("div", "snowpack-rerank");
    note.appendChild(txt("span", "snowpack-rerank-msg", lastRerankNote));
    const acts = el("div", "snowpack-rerank-acts");
    if (Array.isArray(state.ledger) && state.ledger.length) {
      const undo = txt("button", "snowpack-rerank-undo", "Undo"); undo.type = "button";
      undo.onclick = undoLastLog;
      acts.appendChild(undo);
    }
    const ok = txt("button", "snowpack-rerank-x", "Got it"); ok.type = "button";
    ok.onclick = () => { lastRerankNote = null; buildApp(); };
    acts.appendChild(ok);
    note.appendChild(acts);
    card.appendChild(note);
  }

  if (snowpackLogOpen) {
    // The living-ledger log panel: pre-filled with the plan, one tap to confirm,
    // every field editable if reality differed. Applying it rewrites balances.
    const extra = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
    const rec = recommendedThisMonth(active, state.strategy, extra);
    const panel = el("div", "snowpack-log");
    panel.appendChild(txt("div", "snowpack-log-title", `Log ${monthKeyLabel(thisMonth)}'s payments`));
    panel.appendChild(txt("p", "snowpack-log-hint", "We filled in your plan — tweak any that differed, then confirm. Your balances update to match reality."));
    const inputs = [];
    active.forEach((d) => {
      const row = el("div", "snowpack-log-row");
      row.appendChild(txt("span", "snowpack-log-name", (d.name || "").trim() || "Unnamed debt"));
      const inWrap = el("div", "snowpack-log-inwrap");
      inWrap.appendChild(txt("span", "snowpack-log-dollar", "$"));
      const inp = el("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.className = "snowpack-log-input";
      inp.value = String(Math.round((rec[d.id] || 0) * 100) / 100);
      inp.setAttribute("aria-label", `Amount paid on ${(d.name || "").trim() || "this debt"}`);
      inWrap.appendChild(inp);
      row.appendChild(inWrap);
      inputs.push({ id: d.id, inp });
      panel.appendChild(row);
    });
    const acts = el("div", "snowpack-log-acts");
    const confirm = txt("button", "btn brand sm", "Log payments"); confirm.type = "button";
    confirm.onclick = () => {
      const amounts = {};
      inputs.forEach(({ id, inp }) => { amounts[id] = safeNumber(inp.value, { min: 0, max: MAX_MONEY }); });
      applyMonthlyLog(thisMonth, amounts);
    };
    const cancel = txt("button", "snowpack-log-cancel", "Cancel"); cancel.type = "button";
    cancel.onclick = () => { snowpackLogOpen = false; buildApp(); };
    acts.append(confirm, cancel);
    panel.appendChild(acts);
    card.appendChild(panel);
  } else if (loggedThisMonth) {
    const done = el("div", "snowpack-donerow");
    done.appendChild(txt("span", "snowpack-donelabel", `✓ Logged for ${monthKeyLabel(thisMonth)}`));
    const undo = txt("button", "snowpack-undo", "Undo"); undo.type = "button"; undo.onclick = undoThisMonth;
    done.appendChild(undo);
    card.appendChild(done);
  } else {
    const btn = txt("button", "btn snowpack-btn", "Log this month's payments"); btn.type = "button";
    btn.onclick = () => { snowpackLogOpen = true; buildApp(); };
    card.appendChild(btn);
  }

  // Snowflake quick-add — the everyday loop between monthly check-ins. Hidden
  // while the full monthly log panel is open so there's only ever one input area.
  if (!snowpackLogOpen) {
    if (snowflakeOpen) {
      const focus = focusDebt(active, state.strategy);
      const fname = focus ? ((focus.name || "").trim() || "your focus debt") : "your focus debt";
      const sf = el("div", "snowflake-panel");
      sf.appendChild(txt("div", "snowflake-title", "❄️ Log a snowflake"));
      sf.appendChild(txt("p", "snowflake-hint", `Found money — a rebate, cashback, something you sold? Drop it on ${fname} and watch your date move.`));
      const row = el("div", "snowflake-row");
      const inWrap = el("div", "snowflake-inwrap");
      inWrap.appendChild(txt("span", "snowflake-dollar", "$"));
      const amt = el("input"); amt.type = "text"; amt.inputMode = "decimal"; amt.className = "snowflake-amt"; amt.placeholder = "0";
      amt.setAttribute("aria-label", "Snowflake amount");
      inWrap.appendChild(amt);
      row.appendChild(inWrap);
      const src = el("input"); src.type = "text"; src.className = "snowflake-src"; src.placeholder = "source (optional)"; src.maxLength = 40;
      src.setAttribute("aria-label", "Snowflake source (optional)");
      row.appendChild(src);
      sf.appendChild(row);
      const acts = el("div", "snowflake-acts");
      const add = txt("button", "btn brand sm", "Add it"); add.type = "button";
      add.onclick = () => applySnowflake(amt.value, src.value);
      const cancel = txt("button", "snowflake-cancel", "Cancel"); cancel.type = "button";
      cancel.onclick = () => { snowflakeOpen = false; buildApp(); };
      acts.append(add, cancel);
      sf.appendChild(acts);
      card.appendChild(sf);
    } else {
      const sfBtn = txt("button", "snowflake-toggle", "❄️ Log a snowflake"); sfBtn.type = "button";
      sfBtn.onclick = () => { snowflakeOpen = true; buildApp(); };
      card.appendChild(sfBtn);
    }
  }

  const hist = buildLedgerHistory();
  if (hist) card.appendChild(hist);
  return card;
}

// ── The Cascade (free) ──────────────────────────────────────────────────────
// The snowball made visible: scrub a month slider (or hit Play) and watch each
// debt's bar shrink to zero, then its freed payment roll onto the next — faster
// and faster. Uses the SAME simulator (trackPerDebt) so it matches the plan
// exactly. Respects prefers-reduced-motion (Play jumps to the end, no ticking).
function buildCascadeCard(activeDebts, strategy, extra, primary) {
  if (!primary || primary.neverPaysOff || primary.months < 1) return null;
  const sim = simulateStrategy(activeDebts, strategy, extra, { trackPerDebt: true });
  if (!sim.series || sim.months < 1) return null;
  const months = sim.months;
  const ordered = [...activeDebts].sort((a, b) => (sim.payoffMonth[a.id] || Infinity) - (sim.payoffMonth[b.id] || Infinity));
  const maxStart = Math.max(1, ...ordered.map((d) => sim.startById[d.id] || 0));

  const card = el("div", "panel cascade-card");
  card.appendChild(txt("h3", null, "Watch your snowball roll"));
  card.appendChild(txt("p", "hint", "Scrub through time and watch each debt fall — then its payment rolls onto the next, faster and faster. That's the snowball."));

  const bars = el("div", "cascade-bars");
  const barEls = {};
  ordered.forEach((d, i) => {
    const row = el("div", "cascade-row");
    row.appendChild(txt("span", "cascade-name", (d.name || "").trim() || `Debt ${i + 1}`));
    const trackEl = el("div", "cascade-track");
    const fill = el("div", "cascade-fill");
    trackEl.appendChild(fill);
    row.appendChild(trackEl);
    const val = txt("span", "cascade-val", money(sim.startById[d.id] || 0));
    row.appendChild(val);
    bars.appendChild(row);
    barEls[d.id] = { fill, val, row };
  });
  card.appendChild(bars);

  const monthLabel = txt("div", "cascade-month", "");
  const controls = el("div", "cascade-controls");
  const playBtn = txt("button", "btn ghost sm cascade-play", "▶ Play"); playBtn.type = "button";
  const slider = el("input");
  slider.type = "range"; slider.min = "0"; slider.max = String(months); slider.value = "0"; slider.step = "1";
  slider.className = "cascade-slider";
  slider.setAttribute("aria-label", "Scrub the payoff timeline by month");
  controls.append(playBtn, slider);
  card.append(monthLabel, controls);

  const at = (id, m) => { const arr = sim.series[id]; return arr ? (arr[Math.min(m, arr.length - 1)] || 0) : 0; };
  function renderAt(m) {
    m = Math.max(0, Math.min(months, m | 0));
    let totalRem = 0;
    ordered.forEach((d) => {
      const bal = at(d.id, m); totalRem += bal;
      const pct = Math.max(0, Math.min(100, (bal / maxStart) * 100));
      const be = barEls[d.id];
      be.fill.style.width = pct + "%";
      const done = bal <= 0.5;
      be.val.textContent = done ? "Paid ✓" : money(bal);
      be.row.classList.toggle("cascade-done", done);
    });
    const date = formatDate(addMonths(new Date(), m));
    monthLabel.textContent = m === 0 ? `Today — ${money(totalRem)} to go` : `Month ${m} · ${date} — ${money(totalRem)} to go`;
  }
  slider.oninput = () => renderAt(parseInt(slider.value, 10) || 0);

  const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  let timer = null;
  function stop() { if (timer) { clearInterval(timer); timer = null; } playBtn.textContent = "▶ Play"; }
  playBtn.onclick = () => {
    if (timer) { stop(); return; }
    if (reduce) { slider.value = String(months); renderAt(months); return; }
    let m = parseInt(slider.value, 10) || 0;
    if (m >= months) m = 0;
    playBtn.textContent = "⏸ Pause";
    const stepMs = Math.max(45, Math.min(150, Math.round(3200 / months)));
    timer = setInterval(() => {
      if (!slider.isConnected) { clearInterval(timer); timer = null; return; } // detached (nav/rebuild) → self-clean
      m++;
      slider.value = String(m);
      renderAt(m);
      if (m >= months) stop();
    }, stepMs);
  };
  renderAt(0);
  return card;
}

// ── Interest Clock (free) ───────────────────────────────────────────────────
// The visceral daily cost of carrying this debt — pure arithmetic from today's
// balances × APR, no new state. Honest ("at today's balances") and framed to
// motivate (it shrinks with every payment), never to shame. Returns null when
// there's no interest to show (0% cards or no balances yet).
function buildInterestClock(active) {
  const daily = active.reduce((s, d) => s + Math.max(0, d.balance) * (Math.max(0, d.apr) / 100 / 365), 0);
  if (!(daily > 0.005)) return null;
  const nightly = daily * (8 / 24); // ~8 hours of sleep
  const card = el("div", "panel interest-clock");
  card.appendChild(txt("div", "ic-label", "Your debt is costing you"));
  const fig = el("div", "ic-figure");
  fig.appendChild(txt("span", "ic-amount", moneyPrecise(daily)));
  fig.appendChild(txt("span", "ic-unit", "today"));
  card.appendChild(fig);
  card.appendChild(txt("div", "ic-sub", `About ${moneyPrecise(nightly)} while you sleep tonight.`));
  card.appendChild(txt("div", "ic-note", "At today's balances — every payment you make shrinks this."));
  // Per-debt breakdown — which card is bleeding you fastest (only when more than
  // one debt actually accrues interest, so a single debt doesn't just restate it).
  const perDebt = active
    .map((d) => ({ name: (d.name || "").trim() || "Untitled debt", d: Math.max(0, d.balance) * (Math.max(0, d.apr) / 100 / 365) }))
    .filter((x) => x.d > 0.005);
  if (perDebt.length > 1) {
    const list = el("ul", "daily-cost-list");
    perDebt.sort((a, b) => b.d - a.d).forEach((x) => {
      const li = el("li", "daily-cost-item");
      li.appendChild(txt("span", "daily-cost-item-name", x.name));
      li.appendChild(txt("span", "daily-cost-item-val", moneyPrecise(x.d) + "/day"));
      list.appendChild(li);
    });
    card.appendChild(list);
  }
  return card;
}

// ── Minimum-payment trap X-ray (free) ───────────────────────────────────────
// Shows, in the user's OWN numbers, the cost of coasting on minimums (each debt
// paid at its own minimum with no roll-forward) versus their actual plan (which
// rolls freed-up payments forward, plus any extra). Same pure simulator; returns
// null when it can't compare honestly (a minimum below interest never pays off).
function buildTrapXray(active, strategy, extra) {
  let minsInterest = 0, minsMonths = 0, minsNeverPays = false;
  for (const d of active) {
    // Minimums-only, with realistic SHRINKING minimums for percent debts (the trap).
    const r = simulateStrategy([d], strategy, 0, { minimumsOnly: true });
    minsInterest += r.totalInterest;
    if (r.neverPaysOff) { minsNeverPays = true; minsMonths = Math.max(minsMonths, CAP_MONTHS); }
    else minsMonths = Math.max(minsMonths, r.months);
  }
  const plan = simulateStrategy(active, strategy, extra);
  if (plan.neverPaysOff) return null; // can't compare against a plan that doesn't resolve
  const interestSaved = minsInterest - plan.totalInterest;
  const monthsSaved = minsMonths - plan.months;
  // Show it whenever there's a real gap — OR when minimums never clear (the worst
  // trap of all, which we must NOT hide just because there's no finite number).
  if (!minsNeverPays && interestSaved < 1 && monthsSaved < 1) return null;

  const card = el("div", "panel trap-xray");
  card.appendChild(txt("div", "tx-head", "The minimum-payment trap"));
  const rows = el("div", "tx-rows");
  const row = (cls, label, val) => {
    const r = el("div", `tx-row ${cls}`);
    r.appendChild(txt("span", "tx-row-label", label));
    r.appendChild(txt("span", "tx-row-val", val));
    return r;
  };
  rows.appendChild(row("tx-bad", "Paying only minimums", minsNeverPays
    ? `Over ${CAP_MONTHS / 12} years — never clears`
    : `${monthsLabel(minsMonths)} · ${money(minsInterest)} interest`));
  rows.appendChild(row("tx-good", "Your plan", `${monthsLabel(plan.months)} · ${money(plan.totalInterest)} interest`));
  card.appendChild(rows);
  const delta = el("p", "tx-delta");
  if (minsNeverPays) {
    delta.appendChild(document.createTextNode("On minimums alone this never clears in "));
    const b = el("b"); b.textContent = `${CAP_MONTHS / 12} years`; delta.appendChild(b);
    delta.appendChild(document.createTextNode(` — your plan clears it in ${monthsLabel(plan.months)}.`));
  } else {
    const parts = [];
    if (interestSaved >= 1) parts.push(money(interestSaved) + " in interest");
    if (monthsSaved >= 1) parts.push(monthsLabel(monthsSaved) + " sooner");
    delta.appendChild(document.createTextNode("Rolling every payment forward saves you "));
    const b = el("b"); b.textContent = parts.join(" and "); delta.appendChild(b);
    delta.appendChild(document.createTextNode("."));
  }
  card.appendChild(delta);
  if (active.some((d) => d.minKind === "percent")) {
    card.appendChild(txt("p", "tx-note", "Assumes your minimum shrinks as the balance falls — the way real credit-card minimums work."));
  }
  return card;
}

function buildMotivationCard(primary) {
  const card = el("div", "motiv-card");
  const art = el("div", "motiv-art");
  art.setAttribute("aria-hidden", "true");
  // Snowy summit with a blue flag-and-check planted at the peak (mockup art),
  // re-drawn as clean inline SVG. Tokened classes give both-theme fills.
  art.innerHTML =
    `<svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">` +
      `<circle class="motiv-sky" cx="48" cy="48" r="46"/>` +
      // back peak
      `<path class="motiv-mtn-back" d="M4 78 L34 40 L58 78 Z"/>` +
      // front peak
      `<path class="motiv-mtn" d="M22 82 L54 30 L88 82 Z"/>` +
      // snow caps
      `<path class="motiv-snow" d="M54 30 L46 44 L52 46 L47 52 L64 52 L58 44 L62 44 Z"/>` +
      `<path class="motiv-snow" d="M34 40 L29 48 L33 49 L30 54 L44 54 L38 47 Z" opacity="0.9"/>` +
      // flag pole + blue pennant with a white check
      `<path class="motiv-flag-pole" d="M54 30 L54 12" stroke-width="2.6" stroke-linecap="round"/>` +
      `<path class="motiv-flag" d="M54 13 L74 18 L54 25 Z"/>` +
      `<path class="motiv-flag-check" d="M60 19.5 l2.4 2.4 4.6 -5" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
  const body = el("div", "motiv-body");
  body.appendChild(txt("h4", "motiv-title", "Small steps today, big freedom tomorrow"));
  body.appendChild(txt("p", "motiv-sub", "Stay consistent and watch your snowball grow."));
  // Non-pushy, warm. Uses the honest plan length; falls back gently if unknown.
  const line = primary && !primary.neverPaysOff && primary.months > 0
    ? `You've got a clear path to the summit — ${monthsLabel(primary.months)} of steady steps and you're there. Take it one payment at a time.`
    : "Every debt you map out is a step toward the summit. Take it one payment at a time — you've got this.";
  body.appendChild(txt("p", "motiv-text", line));
  card.append(art, body);
  return card;
}

// ── Snowball vs Avalanche comparison card (free, derived live) ─────────────
// Runs the SAME pure simulateStrategy() for BOTH strategies against the current
// debts + extra, and shows each one's debt-free date + total interest, plus a
// plain-language takeaway. `primary`/`other` are passed in already-computed by
// the caller (buildResults), so no strategy is simulated twice. `chosen` is the
// user's current strategy id; `otherId` its opposite. When both strategies reach
// the same finish line and cost, the takeaway says they're equivalent here.
// Short, honest one-line trade-off hint for the strategy picker, derived from
// the SAME primary/other sims the comparison card uses (computed once by the
// caller). Says which strategy is cheaper for THESE debts, or that they're
// about equal when the interest difference is under half a dollar.
function strategyPickerHint(chosen, primary, other) {
  let msg;
  if (chosen === "custom") {
    if (primary.neverPaysOff) msg = "Your own payoff order — add balances and minimums to see what it costs.";
    else if (other.neverPaysOff) msg = "Your own payoff order, worked out on this device.";
    else {
      const diff = primary.totalInterest - other.totalInterest; // your order minus Avalanche
      msg = diff > 0.5
        ? `Your own order — Avalanche would save about ${money(diff)} in interest, but this order is yours.`
        : "Your own order — as cheap as Avalanche for your debts. Nice.";
    }
    const p = txt("p", "hint picker-hint", msg);
    p.setAttribute("role", "status"); p.setAttribute("aria-live", "polite");
    return p;
  }
  if (primary.neverPaysOff || other.neverPaysOff) {
    msg = "Add an extra payment to compare what each strategy would cost.";
  } else {
    const interestDiff = primary.totalInterest - other.totalInterest; // your pick minus the other
    if (Math.abs(interestDiff) < 0.5) {
      msg = "Both strategies cost about the same in interest for your debts.";
    } else if (interestDiff > 0) {
      // The other strategy is cheaper than the current pick.
      const otherName = chosen === "snowball" ? "Avalanche" : "Snowball";
      msg = `${otherName} would save about ${money(interestDiff)} in interest for your debts.`;
    } else {
      // Current pick is the cheaper one.
      const chosenName = chosen === "snowball" ? "Snowball" : "Avalanche";
      msg = `${chosenName} saves you about ${money(-interestDiff)} in interest versus the other strategy.`;
    }
  }
  const p = txt("p", "hint picker-hint", msg);
  p.setAttribute("role", "status");
  p.setAttribute("aria-live", "polite");
  return p;
}

// The drag-free reorder list for the "Custom" strategy: nudge debts up/down.
function buildCustomOrderList(active) {
  if (!active || !active.length) return null;
  const originalIndex = new Map(active.map((d, i) => [d.id, i]));
  const inOrder = orderDebts(active, "custom", originalIndex);
  const ids = inOrder.map((d) => d.id);
  const wrap = el("div", "customorder");
  wrap.appendChild(txt("div", "customorder-title", "Your payoff order"));
  wrap.appendChild(txt("p", "customorder-hint", "Nudge debts up or down — every extra dollar goes to the top one first."));
  inOrder.forEach((d, i) => {
    const rowEl = el("div", "customorder-row");
    rowEl.appendChild(txt("span", "customorder-pos", String(i + 1)));
    rowEl.appendChild(txt("span", "customorder-name", (d.name || "").trim() || `Debt ${i + 1}`));
    const btns = el("div", "customorder-btns");
    const move = (from, to) => { const a = ids.slice(); const t = a[from]; a[from] = a[to]; a[to] = t; state.customOrder = a; persistNow(); buildApp(); };
    const up = txt("button", "customorder-btn", "↑"); up.type = "button"; up.disabled = i === 0;
    up.setAttribute("aria-label", `Move ${(d.name || "").trim() || "this debt"} up`);
    up.onclick = () => move(i, i - 1);
    const down = txt("button", "customorder-btn", "↓"); down.type = "button"; down.disabled = i === ids.length - 1;
    down.setAttribute("aria-label", `Move ${(d.name || "").trim() || "this debt"} down`);
    down.onclick = () => move(i, i + 1);
    btns.append(up, down);
    rowEl.appendChild(btns);
    wrap.appendChild(rowEl);
  });
  return wrap;
}
function buildCustomCompareCard(mine, avalanche) {
  const panel = el("div", "panel compare-panel");
  panel.appendChild(txt("h3", null, "Your order vs Avalanche"));
  const rowFor = (name, plan, isPick) => {
    const row = el("div", `compare-row${isPick ? " is-chosen" : ""}`);
    const head = el("div", "compare-row-head");
    head.appendChild(txt("span", "compare-name", name));
    if (isPick) head.appendChild(txt("span", "compare-chosen-tag", "Your pick"));
    row.appendChild(head);
    const stats = el("div", "compare-stats");
    const d = el("div", "compare-stat");
    d.appendChild(txt("span", "compare-stat-label", "Debt-free"));
    d.appendChild(txt("span", "compare-stat-val", plan.neverPaysOff ? "Not within " + (CAP_MONTHS / 12) + " yrs" : formatDate(addMonths(new Date(), plan.months))));
    const i = el("div", "compare-stat");
    i.appendChild(txt("span", "compare-stat-label", "Total interest"));
    i.appendChild(txt("span", "compare-stat-val", plan.neverPaysOff ? "—" : money(plan.totalInterest)));
    stats.append(d, i); row.appendChild(stats);
    return row;
  };
  panel.appendChild(rowFor("Your order", mine, true));
  panel.appendChild(rowFor("Avalanche", avalanche, false));
  let takeaway;
  if (mine.neverPaysOff || avalanche.neverPaysOff) takeaway = "Add an extra payment to compare finish lines.";
  else {
    const diff = mine.totalInterest - avalanche.totalInterest;
    takeaway = diff > 0.5
      ? `Your order costs about ${money(diff)} more in interest than Avalanche — a fair price for paying them off your way.`
      : "Your order is as cheap as Avalanche for your debts.";
  }
  panel.appendChild(txt("p", "hint compare-takeaway", takeaway));
  return panel;
}
function buildStrategyCompareCard(chosen, primary, other) {
  if (chosen === "custom") return buildCustomCompareCard(primary, other);
  const panel = el("div", "panel compare-panel");
  panel.appendChild(txt("h3", null, "Snowball vs Avalanche"));

  const snowball = chosen === "snowball" ? primary : other;
  const avalanche = chosen === "avalanche" ? primary : other;

  const rowFor = (id, name, plan) => {
    const row = el("div", `compare-row${chosen === id ? " is-chosen" : ""}`);
    const head = el("div", "compare-row-head");
    head.appendChild(txt("span", "compare-name", name));
    if (chosen === id) {
      const tag = txt("span", "compare-chosen-tag", "Your pick");
      row.setAttribute("aria-label", `${name} (your current strategy)`);
      head.appendChild(tag);
    }
    row.appendChild(head);
    const stats = el("div", "compare-stats");
    const dateStat = el("div", "compare-stat");
    dateStat.appendChild(txt("span", "compare-stat-label", "Debt-free"));
    dateStat.appendChild(txt("span", "compare-stat-val", plan.neverPaysOff ? "Not within " + (CAP_MONTHS / 12) + " yrs" : formatDate(addMonths(new Date(), plan.months))));
    const intStat = el("div", "compare-stat");
    intStat.appendChild(txt("span", "compare-stat-label", "Total interest"));
    intStat.appendChild(txt("span", "compare-stat-val", plan.neverPaysOff ? "—" : money(plan.totalInterest)));
    stats.append(dateStat, intStat);
    row.appendChild(stats);
    return row;
  };

  panel.appendChild(rowFor("snowball", "Snowball", snowball));
  panel.appendChild(rowFor("avalanche", "Avalanche", avalanche));

  // Plain-language takeaway. Only meaningful when both strategies resolve.
  let takeaway;
  if (snowball.neverPaysOff || avalanche.neverPaysOff) {
    takeaway = "At this payment level, the plan doesn't fully pay off within " + (CAP_MONTHS / 12) + " years — add an extra payment to compare finish lines.";
  } else {
    const interestDiff = primary.totalInterest - other.totalInterest; // primary minus other
    const monthDiff = primary.months - other.months;
    const otherName = chosen === "snowball" ? "Avalanche" : "Snowball";
    if (Math.abs(interestDiff) < 0.5 && monthDiff === 0) {
      takeaway = "For your debts, both strategies finish on the same date for the same interest — pick whichever keeps you motivated.";
    } else if (interestDiff > 0.5 || (interestDiff >= -0.5 && monthDiff > 0)) {
      // The OTHER strategy is cheaper and/or faster than your current pick.
      const bits = [];
      if (interestDiff > 0.5) bits.push(`saves you ${money(interestDiff)} in interest`);
      if (monthDiff > 0) bits.push(`gets you there ${monthsLabel(monthDiff)} sooner`);
      takeaway = `${otherName} ${bits.join(" and ")}.`;
    } else {
      // Your current pick costs more but has its own upside (first-debt momentum
      // for snowball; nothing to sugar-coat for a slower avalanche).
      const extraCost = other.totalInterest - primary.totalInterest; // your pick minus cheaper one
      if (chosen === "snowball") {
        takeaway = extraCost > 0.5
          ? `Snowball costs about ${money(extraCost)} more in interest, but clears your smallest debt first for an early win.`
          : "Snowball clears your smallest debt first for an early win, at no real extra interest cost.";
      } else {
        takeaway = extraCost > 0.5
          ? `Avalanche costs about ${money(extraCost)} more here — Snowball would be cheaper for your debts.`
          : "Both strategies cost about the same in interest for your debts.";
      }
    }
  }
  panel.appendChild(txt("p", "hint compare-takeaway", takeaway));

  // Honest, cited nudge: when both resolve, remind them the "best" method is the
  // one they'll finish. Research (Gal & McShane, 2016, Journal of Marketing
  // Research) found knocking out whole balances early predicts who actually
  // pays it all off — even though Avalanche saves more on paper.
  if (!snowball.neverPaysOff && !avalanche.neverPaysOff) {
    panel.appendChild(txt("p", "hint compare-research",
      "Studies of real payoffs find people are likelier to finish when they clear small balances first — so the method you'll actually stick with usually beats the one that's a little cheaper on paper."));
  }
  return panel;
}

// ── Daily interest cost card (free, derived live) ──────────────────────────
// "What your debt costs you" — the total interest accruing per day across all
// active debts, computed the same way debtWarning() does its monthly figure:
// balance * (apr/100) / 365 per debt. Optional per-debt breakdown below the
// headline. Pure derivation from state.debts; nothing persisted.

// ── Debt-free countdown line (free, derived live) ──────────────────────────
// A prominent, hopeful line: the human duration to the debt-free date plus the
// exact number of days from today. Days are computed from today to the first of
// the payoff month (addMonths), so the "days" figure always agrees with the
// on-screen debt-free date. Only shown when the plan actually resolves.
function buildCountdownLine(primary) {
  const line = el("div", "countdown");
  line.setAttribute("role", "img");
  const target = addMonths(new Date(), primary.months);
  // Whole days from the start of today to the start of the payoff month.
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.max(0, Math.round((target - startOfToday) / 86400000));
  const human = monthsLabel(primary.months);
  const dayWord = days === 1 ? "day" : "days";
  line.setAttribute("aria-label", `You'll be debt-free in ${human}, about ${days} ${dayWord} from today.`);

  const icon = el("span", "countdown-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M21 3v6h-6"/><path d="M12 8v4l3 2"/></svg>';
  line.appendChild(icon);

  const body = el("div", "countdown-body");
  const lead = el("p", "countdown-lead");
  lead.appendChild(document.createTextNode("You'll be debt-free in "));
  lead.appendChild(txt("strong", "countdown-dur", human));
  body.appendChild(lead);
  body.appendChild(txt("p", "countdown-days", `That's about ${days.toLocaleString("en-US")} ${dayWord} from today — you've got this.`));
  line.appendChild(body);
  return line;
}

// ── Milestone timeline (free, derived live) ────────────────────────────────
// A compact "wins" timeline: one row per debt in payoff order, each showing the
// debt name + the month it disappears (from primary.payoffMonth), capped with a
// final "Debt-free" marker. Pure inline SVG-free markup; the whole strip carries
// a role=list with an aria-label text equivalent so it isn't graphic-only.
function buildMilestoneTimeline(activeDebts, primary) {
  const panel = el("div", "panel timeline-panel");
  panel.appendChild(txt("h3", null, "Your wins along the way"));

  const ranked = [...activeDebts].sort((a, b) => (primary.payoffMonth[a.id] || Infinity) - (primary.payoffMonth[b.id] || Infinity));
  const list = el("ol", "timeline");
  list.setAttribute("aria-label", "Milestone timeline: each debt in the order it gets paid off, ending debt-free.");

  ranked.forEach((d, i) => {
    const item = el("li", "timeline-item");
    const dot = el("span", "timeline-dot"); dot.setAttribute("aria-hidden", "true");
    dot.appendChild(txt("span", "timeline-dot-num", String(i + 1)));
    item.appendChild(dot);
    const body = el("div", "timeline-body");
    body.appendChild(txt("span", "timeline-name", (d.name || "").trim() || "Untitled debt"));
    const payoffM = primary.payoffMonth[d.id];
    body.appendChild(txt("span", "timeline-when", payoffM ? "Paid off " + formatDate(addMonths(new Date(), payoffM)) : "Beyond " + (CAP_MONTHS / 12) + " years"));
    item.appendChild(body);
    list.appendChild(item);
  });

  // Final debt-free marker.
  const done = el("li", "timeline-item is-done");
  const flag = el("span", "timeline-dot timeline-dot-done"); flag.setAttribute("aria-hidden", "true");
  flag.innerHTML = CELEBRATE_SVG;
  done.appendChild(flag);
  const doneBody = el("div", "timeline-body");
  doneBody.appendChild(txt("span", "timeline-name", "Debt-free"));
  doneBody.appendChild(txt("span", "timeline-when", primary.neverPaysOff ? "Keep going — raise a payment to reach it" : formatDate(addMonths(new Date(), primary.months))));
  done.appendChild(doneBody);
  list.appendChild(done);

  panel.appendChild(list);
  return panel;
}

// ── Results panel ────────────────────────────────────────────────────────
// `mode` selects which slice of the plan this render produces, so the same
// builders can be mounted into the router's two content views without any of
// the math or component code being duplicated or rewritten:
//   "summary" (Plan view)   — the four summary stat tiles + honest empty state.
//   "detail"  (Payoff view) — the harvested plan: ring, payoff-order table,
//                             donut, motivation, chart, what-if, export/share.
//   "full" (default)        — the original single-scroll everything, kept so
//                             any legacy caller still gets the exact old output.
function buildResults(mode) {
  mode = mode || "full";
  const wantSummary = mode === "full" || mode === "summary";
  const wantDetail = mode === "full" || mode === "detail";
  const card = el("div");
  const activeDebts = planScopedDebts().filter((d) => d.balance > 0 && d.minPayment > 0);

  if (!activeDebts.length) {
    if (wantSummary) {
      const empty = el("div", "panel");
      empty.appendChild(panelTitle("Your payoff plan", "plan"));
      // Honest empty summary header — the four tiles present with placeholder
      // dashes so the layout reads the same, mirroring the app's existing
      // "add at least one debt" messaging below.
      const emptySummary = el("div", "summary-grid is-empty");
      emptySummary.appendChild(summaryTile("brand", "debt", "—", "Total debt"));
      emptySummary.appendChild(summaryTile("violet", "apr", "—", "Average APR"));
      emptySummary.appendChild(summaryTile("green", "date", "—", "Debt-free date"));
      emptySummary.appendChild(summaryTile("amber", "pay", "—", "Monthly payment"));
      emptySummary.appendChild(summaryTile("amber", "interest", "—", "Total interest"));
      empty.appendChild(emptySummary);
      empty.appendChild(emptyStateBlock(
        "Your plan builds itself here",
        "Add at least one debt with a balance and a minimum payment to see your plan."
      ));
      card.appendChild(empty);
    }
    if (wantDetail && mode === "detail") {
      // Payoff view with nothing to show yet — its own honest empty state so the
      // route never renders a blank column.
      const empty = el("div", "panel");
      empty.appendChild(panelTitle("Your payoff plan", "plan"));
      empty.appendChild(emptyStateBlock(
        "No payoff plan yet",
        "Add at least one debt with a balance and a minimum payment on the Plan page to see your payoff order, charts, and what-if tools here.",
        "clipboard"
      ));
      card.appendChild(empty);
    }
    return card;
  }

  const primary = simulateStrategy(activeDebts, state.strategy, state.extraPayment);
  const other = simulateStrategy(activeDebts, otherStrategy(state.strategy), state.extraPayment);

  // ── Summary stat-card header (mockup card language) ──
  // All derived live: total debt = sum of active balances; average APR =
  // balance-weighted mean; debt-free date + monthly payment from the sim.
  // No new state, no persisted fields.
  const totalDebt = activeDebts.reduce((s, d) => s + d.balance, 0);
  const weightedApr = totalDebt > 0
    ? activeDebts.reduce((s, d) => s + d.apr * d.balance, 0) / totalDebt
    : 0;
  const totalMinPay = activeDebts.reduce((s, d) => s + d.minPayment, 0);
  const extraPay = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
  const monthlyPay = totalMinPay + extraPay;
  const summaryDateStr = primary.neverPaysOff ? "—" : formatDate(addMonths(new Date(), primary.months));
  const summary = el("div", "summary-grid");
  summary.appendChild(summaryTile("brand", "debt", money(totalDebt), "Total debt"));
  summary.appendChild(summaryTile("violet", "apr", weightedApr.toFixed(2) + "%", "Average APR"));
  summary.appendChild(summaryTile("green", "date", summaryDateStr, "Debt-free date"));
  summary.appendChild(summaryTile("amber", "pay", money(monthlyPay), "Monthly payment"));
  // Total interest is the ONE summary figure that differs between Snowball and
  // Avalanche — surfacing it here (next to the strategy picker on the Plan view)
  // is what makes toggling the strategy visibly change a number.
  summary.appendChild(summaryTile("amber", "interest", primary.neverPaysOff ? "—" : money(primary.totalInterest), "Total interest"));

  // Summary stat tiles live on the Plan (at-a-glance) view.
  if (wantSummary) {
    const summaryPanel = el("div", "panel");
    summaryPanel.appendChild(panelTitle("Your payoff plan", "plan"));
    summaryPanel.appendChild(summary);
    if (primary.neverPaysOff) {
      summaryPanel.appendChild(warnBox(neverPaysOffMessage(activeDebts, state.strategy)));
    }
    summaryPanel.appendChild(txt("p", "hint", "Projections are estimates for planning, not financial advice."));
    card.appendChild(summaryPanel);
  }

  // The detailed harvested plan (stat grid, export/share, what-if, ring,
  // payoff table, donut, motivation, chart) is the Payoff view.
  if (!wantDetail) return card;

  const panel = el("div", "panel");
  // In the standalone Payoff view this panel carries the section heading; in
  // legacy "full" mode the summary panel above already showed it, so don't
  // repeat it there.
  if (!wantSummary) panel.appendChild(panelTitle("Your payoff plan", "plan"));

  if (primary.neverPaysOff) {
    panel.appendChild(warnBox(neverPaysOffMessage(activeDebts, state.strategy)));
  } else {
    const stats = el("div", "stat-grid");
    const debtFreeDate = formatDate(addMonths(new Date(), primary.months));
    stats.appendChild(statCard(debtFreeDate, "Debt-free date"));
    stats.appendChild(statCard(monthsLabel(primary.months), "Time to freedom"));
    stats.appendChild(statCard(money(primary.totalInterest), "Total interest paid"));
    panel.appendChild(stats);

    // Hopeful debt-free countdown, right under the summary stats.
    panel.appendChild(buildCountdownLine(primary));

    if (!other.neverPaysOff && other.totalInterest !== primary.totalInterest) {
      const otherName = otherStrategy(state.strategy) === "avalanche" ? "Avalanche" : "Snowball";
      const interestDiff = primary.totalInterest - other.totalInterest;
      const monthDiff = primary.months - other.months;
      if (interestDiff > 0.5 || Math.abs(monthDiff) >= 1) {
        const bits = [];
        if (interestDiff > 0.5) bits.push(`save ${money(interestDiff)} in interest`);
        if (monthDiff > 0) bits.push(`finish ${monthsLabel(monthDiff)} sooner`);
        else if (monthDiff < 0) bits.push(`take ${monthsLabel(-monthDiff)} longer`);
        if (bits.length) panel.appendChild(txt("p", "hint", `Switching to ${otherName} would ${bits.join(" and ")}.`));
      }
    }

    // ── Export payoff plan as PDF (Pro) ──
    // Gated: free users get the paywall, Pro users get a one-page PDF. The
    // button lives here (not in the never-pays-off branch) because there's
    // no meaningful plan to export until there's a real finish line.
    const exportRow = el("div", "export-row");
    const exportBtn = txt("button", "btn ghost sm", "Export payoff plan (PDF)"); exportBtn.type = "button";
    // Busy state while the PDF builds (first export also lazy-loads pdf-lib) —
    // immediate feedback + guards against a double-click.
    const exportAction = async () => {
      const orig = exportBtn.textContent;
      exportBtn.disabled = true; exportBtn.textContent = "Generating…";
      try { await exportPayoffPlanPdf(activeDebts, primary, exportRow); }
      finally { exportBtn.disabled = false; exportBtn.textContent = orig; }
    };
    // Gate: live entitlement check (busy-state on the button), then export or
    // open the paywall with "export the PDF" as the resume-on-unlock intent.
    exportBtn.onclick = () => gateProAction(exportBtn, { reason: "exportPdf" }, exportAction);
    exportRow.appendChild(exportBtn);

    // ── Share my milestone card (free) ──
    // Generates a branded square PNG of the debt-free date and shares it (Web
    // Share sheet on mobile) or downloads it (desktop fallback). Only shown
    // when there's a real finish line, so it lives inside this branch — the
    // never-pays-off case has no debt-free date to celebrate.
    const shareBtn = txt("button", "btn ghost sm", "Share my milestone"); shareBtn.type = "button";
    shareBtn.onclick = () => {
      const setShareStatus = (message, ok) => {
        const old = exportRow.querySelector(".status-msg");
        if (old) old.remove();
        if (!message) { announce("", false); return; }
        announce(message, !ok);
        const s = el("div", `status-msg ${ok ? "ok" : "err"}`);
        s.appendChild(document.createTextNode(message));
        exportRow.appendChild(s);
      };
      // Derive the headline date from the SAME computed plan the panel shows.
      const dateStr = formatDate(addMonths(new Date(), primary.months));
      const cardCanvas = renderMilestoneCard(primary, activeDebts.length, dateStr);
      shareMilestoneCard(cardCanvas, setShareStatus);
    };
    exportRow.appendChild(shareBtn);
    panel.appendChild(exportRow);

    // ── "What if I paid extra?" live slider (free) ──
    // Live preview only — recomputes the plan at the dragged extra-payment
    // level and shows the debt-free date, interest, and savings vs $0 extra.
    // Does NOT touch state.extraPayment until the user clicks Apply.
    panel.appendChild(buildWhatIfPanel(activeDebts));

    // ── Add-to-calendar (.ics) export (free) ──
    // Hand-writes a valid VCALENDAR of every debt's payoff milestone plus the
    // debt-free date, from the SAME sim already computed. Transient file
    // operation — nothing is persisted.
    panel.appendChild(buildCalendarExportCard(activeDebts, primary));

    // ── Biweekly accelerator (free) ──
    // Models paying half the monthly amount every two weeks (26 half-payments
    // ≈ one extra monthly payment a year). Transient recompute only.
    panel.appendChild(buildBiweeklyCard(activeDebts, primary, monthlyPay));

    // ── One-time windfall modeler (free) ──
    // Applies a hypothetical lump sum in a chosen month to the priority debt.
    // Transient what-if — never writes state.
    panel.appendChild(buildWindfallCard(activeDebts, primary));

    // ── "What this purchase really costs" + Rough-month triage (free) ──
    // Both transient what-ifs; reuse the same pure simulator, write no state.
    {
      const exNow = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
      panel.appendChild(buildPurchaseCostCard(activeDebts, state.strategy, exNow, primary));
      panel.appendChild(buildRoughMonthCard(activeDebts, state.strategy, exNow, primary));
    }

    // ── Refinance / balance-transfer modeler (Pro) ──
    // Swaps one debt's APR (and capitalizes an optional transfer fee onto its
    // balance), re-runs the same sim, and shows the fee-inclusive interest saved
    // vs the base plan. Gated behind the existing Pro paywall inside the card.
    panel.appendChild(buildRefinanceCard(activeDebts, primary));
  }
  card.appendChild(panel);

  // ── Snowball vs Avalanche comparison (free) ──
  // Reuses the primary/other sims already computed above — no extra simulation.
  // Meaningful in both the resolving and never-pays-off cases (its own copy
  // handles the latter honestly), so it lives outside the resolve branch.
  card.appendChild(buildStrategyCompareCard(state.strategy, primary, other));

  // ── Promo-APR cliff guard (Pro) ──
  // Only renders when a debt carries intro-rate terms (which only Pro users can
  // set). Warns before a 0%/low-rate window expires — outside the resolve branch
  // because the jump is worth flagging even when the plan doesn't fully clear.
  {
    const cliff = buildPromoCliffCard(activeDebts, state.strategy, safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY }));
    if (cliff) card.appendChild(cliff);
  }
  { const sl = buildStudentLoanAdvisory(); if (sl) card.appendChild(sl); }

  // (Daily-interest cost now lives as the prominent Interest Clock on the Plan page.)

  // Neither of these panels means anything when there's no finish line —
  // a numbered "payoff order" and a "toward debt-free" thermometer both
  // imply a resolvable plan exists, which directly contradicts the "these
  // debts don't pay off" warning shown above.
  if (!primary.neverPaysOff) {
    // ── The Cascade — the snowball effect animated (free) ──
    {
      const casc = buildCascadeCard(activeDebts, state.strategy, safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY }), primary);
      if (casc) card.appendChild(casc);
    }

    // ── "Where your money goes" ring (honest, always-meaningful) ──
    // No start date exists, so a "% paid / elapsed" ring would always read 0%.
    // Instead show the share of the total payoff that reduces your actual debt
    // (principal) vs interest — always positive, and it RISES as extra payments
    // cut interest, so it rewards the plan. Derived from existing sim output only.
    const ringPrincipal = primary.totalStartBalance;
    const ringTotalCost = ringPrincipal + primary.totalInterest;
    if (ringTotalCost > 0) {
      const toDebtPct = Math.round((ringPrincipal / ringTotalCost) * 100);
      const interestPct = 100 - toDebtPct;
      const ringPanel = el("div", "panel ring-panel");
      ringPanel.appendChild(txt("h3", null, "Where your money goes"));
      ringPanel.appendChild(buildProgressRing(
        toDebtPct,
        toDebtPct + "%",
        "to your debt",
        `Only ${money(primary.totalInterest)} (${interestPct}%) is interest — the rest pays down what you owe. Add extra to shrink it further.`,
        `Where your money goes: ${toDebtPct} percent of your total payoff reduces your debt; ${interestPct} percent (${money(primary.totalInterest)}) is interest.`
      ));
      card.appendChild(ringPanel);
    }

    // ── Payoff order table (step / debt / balance / payoff date + months) ──
    // Every figure read from the EXISTING sim (payoffMonth) — no invented
    // "$ paid" / progress (that's the deferred tracker and must not appear).
    const orderPanel = el("div", "panel");
    orderPanel.appendChild(txt("h3", null, "Payoff order"));
    const ranked = [...activeDebts].sort((a, b) => (primary.payoffMonth[a.id] || Infinity) - (primary.payoffMonth[b.id] || Infinity));
    const scroll = el("div", "payoff-table-scroll");
    const table = el("table", "payoff-table");
    const thead = el("thead");
    const htr = el("tr");
    [["#", "po-col-step"], ["Debt", "po-col-name"], ["Balance", "po-col-bal num"], ["Payoff date", "po-col-date"]]
      .forEach(([label, cls]) => { const th = txt("th", cls, label); th.scope = "col"; htr.appendChild(th); });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el("tbody");
    ranked.forEach((d, i) => {
      const payoffM = primary.payoffMonth[d.id];
      const tr = el("tr", "payoff-trow");
      const stepTd = el("td", "po-col-step");
      stepTd.appendChild(txt("span", "po-step-badge", String(i + 1)));
      tr.appendChild(stepTd);
      tr.appendChild(txt("td", "po-col-name", d.name.trim() || "Untitled debt"));
      tr.appendChild(txt("td", "po-col-bal num", money(d.balance)));
      const dateTd = el("td", "po-col-date");
      if (payoffM) {
        dateTd.appendChild(txt("span", "po-date-main", formatDate(addMonths(new Date(), payoffM))));
        dateTd.appendChild(txt("span", "po-date-sub", monthsLabel(payoffM)));
      } else {
        dateTd.appendChild(txt("span", "po-date-main", "beyond 50 years"));
      }
      tr.appendChild(dateTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    orderPanel.appendChild(scroll);
    card.appendChild(orderPanel);

    // ── Milestone timeline ("wins" strip, in payoff order) ──
    card.appendChild(buildMilestoneTimeline(activeDebts, primary));

    // ── Payment breakdown donut (minimum payments vs extra) ──
    const totalMinPayD = activeDebts.reduce((s, d) => s + d.minPayment, 0);
    const extraD = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
    const donutPanel = el("div", "panel");
    donutPanel.appendChild(txt("h3", null, "Payment breakdown"));
    donutPanel.appendChild(buildBreakdownDonut(totalMinPayD, extraD));
    card.appendChild(donutPanel);

    // ── Motivational card (one tasteful, on-brand encouragement) ──
    card.appendChild(buildMotivationCard(primary));
  }

  // ── Chart ──
  if (!primary.neverPaysOff || !other.neverPaysOff) {
    const chartPanel = el("div", "panel");
    chartPanel.appendChild(txt("h3", null, "Balance over time"));
    const wrap = el("div", "chart-wrap");
    const canvas = el("canvas");
    // The canvas is otherwise invisible to assistive tech — give it a text
    // alternative summarizing the primary strategy's trajectory.
    canvas.setAttribute("role", "img");
    const startBal = primary.totalStartBalance;
    const chartAlt = primary.neverPaysOff
      ? `Balance over time chart. Starting balance ${money(startBal)}; at this payment level the debts don't pay off within ${CAP_MONTHS / 12} years.`
      : `Balance over time chart. Balance falls from ${money(startBal)} today to $0 by ${formatDate(addMonths(new Date(), primary.months))}.`;
    canvas.setAttribute("aria-label", chartAlt);
    wrap.appendChild(canvas);
    chartPanel.appendChild(wrap);
    const legend = el("div", "chart-legend");
    // The primary (snowball-colored) line is your current plan; the other line is
    // the comparison strategy. For a custom order the primary line is "Your order".
    const snowballData = state.strategy === "avalanche" ? other : primary;
    const avalancheData = state.strategy === "avalanche" ? primary : other;
    const legendColors = chartColors();
    // When the two produce the exact same trajectory, only one line is visible —
    // show a single legend entry instead of two swatches implying two lines.
    const primaryLabel = state.strategy === "custom" ? "Your order" : "Snowball";
    const sameSeries = sameTrajectory(snowballData.snapshots, avalancheData.snapshots);
    const legendItems = sameSeries
      ? [[`${primaryLabel} & Avalanche (identical)`, legendColors.snowball]]
      : [[primaryLabel, legendColors.snowball], ["Avalanche", legendColors.avalanche]];
    legendItems.forEach(([name, color]) => {
      const item = el("div", "lg-item");
      const sw = el("span", "lg-swatch"); sw.style.background = color;
      item.append(sw, txt("span", null, name));
      legend.appendChild(item);
    });
    chartPanel.appendChild(legend);
    card.appendChild(chartPanel);
    requestAnimationFrame(() => drawChart(canvas, snowballData.snapshots, avalancheData.snapshots));
  }

  return card;
}
function statCard(value, label) {
  const c = el("div", "stat-card");
  c.appendChild(txt("div", "stat-value", value));
  c.appendChild(txt("div", "stat-label", label));
  return c;
}

// ── "What if I paid extra?" live slider (free) ─────────────────────────────
// A range input from $0 to a generous cap that live-recomputes the plan via
// the same pure simulateStrategy() the results use, and shows the resulting
// debt-free date, total interest, and the SAVINGS versus paying $0 extra.
// It's a preview: it never writes state.extraPayment until "Apply" is clicked.
// The recompute is throttled to one run per animation frame so dragging stays
// smooth even with several debts.
function buildWhatIfPanel(activeDebts) {
  const panel = el("div", "whatif");
  panel.appendChild(txt("h4", "whatif-title", "What if I paid extra?"));
  panel.appendChild(txt("p", "hint", "Drag to preview a different extra monthly payment. Nothing changes until you apply it."));

  // Baseline = $0 extra, so savings are always measured against the plan with
  // no extra payment (not the current state.extraPayment) — that's the honest
  // "what this slider buys you" number.
  const baseline = simulateStrategy(activeDebts, state.strategy, 0);

  // Generous, round cap: 2× the total minimum payment, floored at $500 so a
  // set of tiny minimums still gives a meaningful range to explore, and
  // clamped to MAX_MONEY. Rounded up to a clean $50 step for a tidy track.
  const totalMin = activeDebts.reduce((s, d) => s + d.minPayment, 0);
  const rawMax = Math.max(totalMin * 2, 500);
  const maxExtra = Math.min(MAX_MONEY, Math.ceil(rawMax / 50) * 50);
  // Start the slider at the current extra payment if it fits the range, so the
  // preview opens where the user already is; otherwise at $0.
  const startVal = Math.min(Math.max(0, Math.round(state.extraPayment || 0)), maxExtra);

  const row = el("div", "whatif-row");
  const slider = el("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(maxExtra);
  slider.step = "10";
  slider.value = String(startVal);
  slider.className = "whatif-slider";
  slider.setAttribute("aria-label", "Extra payment per month to preview");
  row.appendChild(slider);
  const amt = txt("div", "whatif-amt", money(startVal) + "/mo");
  row.appendChild(amt);
  panel.appendChild(row);

  const readout = el("div", "whatif-readout");
  readout.setAttribute("role", "status");
  readout.setAttribute("aria-live", "polite");
  readout.setAttribute("aria-atomic", "true");
  panel.appendChild(readout);

  const applyBtn = txt("button", "btn sm whatif-apply", "Apply this extra payment");
  applyBtn.type = "button";
  panel.appendChild(applyBtn);

  // Renders the readout for a given extra-payment level. Pure w.r.t. state —
  // reads nothing it mutates.
  const renderReadout = (extra) => {
    amt.textContent = money(extra) + "/mo";
    const sim = simulateStrategy(activeDebts, state.strategy, extra);
    readout.innerHTML = "";
    if (sim.neverPaysOff) {
      readout.appendChild(txt("p", "whatif-msg", `Even ${money(extra)}/month extra doesn't clear these debts within ${CAP_MONTHS / 12} years at this point. Try raising your minimums.`));
      applyBtn.disabled = false;
      return;
    }
    const dateLabel = formatDate(addMonths(new Date(), sim.months));
    const stats = el("div", "whatif-stats");
    stats.appendChild(whatIfStat(dateLabel, "Debt-free date"));
    stats.appendChild(whatIfStat(money(sim.totalInterest), "Total interest"));
    readout.appendChild(stats);

    // Savings vs $0 extra. Both figures come from the same simulator, so the
    // comparison is apples-to-apples.
    const interestSaved = baseline.totalInterest - sim.totalInterest;
    const monthsSaved = baseline.months - sim.months;
    if (extra <= 0 || (interestSaved < 0.5 && monthsSaved < 1)) {
      readout.appendChild(txt("p", "whatif-save muted", "This is your plan with no extra payment."));
    } else {
      const bits = [];
      if (interestSaved > 0.5) bits.push(`saving ${money(interestSaved)} in interest`);
      if (monthsSaved >= 1) bits.push(`${monthsLabel(monthsSaved)} sooner`);
      readout.appendChild(txt("p", "whatif-save", `Paying ${money(extra)}/mo extra → debt-free ${dateLabel}${bits.length ? ", " + bits.join(" and ") : ""}.`));
    }
    applyBtn.disabled = false;
  };

  // Throttle the recompute to one run per frame so a fast drag doesn't queue
  // dozens of simulations. The slider value is read fresh inside the frame so
  // we always render the latest position, not a stale queued one.
  let frame = null;
  const schedule = () => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      renderReadout(safeNumber(slider.value, { min: 0, max: maxExtra }));
    });
  };
  slider.addEventListener("input", schedule);

  applyBtn.onclick = () => {
    state.extraPayment = safeNumber(slider.value, { min: 0, max: MAX_MONEY });
    scheduleSave();
    buildApp(); // reflects the new extra payment across the strategy field + results
  };

  // Initial paint (synchronous so the readout is populated on first render).
  renderReadout(startVal);
  return panel;
}
function whatIfStat(value, label) {
  const c = el("div", "whatif-stat");
  c.appendChild(txt("div", "whatif-stat-value", value));
  c.appendChild(txt("div", "whatif-stat-label", label));
  return c;
}

// ── Payoff calendar export (.ics) — free ───────────────────────────────────
// Hand-writes a valid VCALENDAR from the ALREADY-computed plan: one all-day
// VEVENT per debt on the 1st of its payoff month, plus a final all-day
// "Debt-free!" VEVENT on the debt-free date. No library, no persistence — a
// pure read of primary.payoffMonth / primary.months. Returns the .ics text.

// RFC 5545 requires CRLF line endings and folding of long lines. These helpers
// keep the generated calendar strictly valid across Apple/Google/Outlook.
function icsEscapeText(s) {
  // Escape the four special characters in TEXT values (backslash, semicolon,
  // comma, newline). The emoji and other unicode pass through as UTF-8.
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
function icsDateStamp(d) {
  // UTC timestamp for DTSTAMP: YYYYMMDDTHHMMSSZ.
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function icsDateValue(d) {
  // DATE value for an all-day event: YYYYMMDD (local calendar date).
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
// The 1st of the month that is `monthsFromNow` months after today. All payoff
// milestones anchor to the 1st so they render as clean all-day markers.
function firstOfMonthAfter(monthsFromNow) {
  const base = new Date();
  return new Date(base.getFullYear(), base.getMonth() + monthsFromNow, 1);
}
// Folds a single logical line to <=75 octets per RFC 5545 (continuation lines
// begin with a single space). Kept simple/char-based — safe for our ASCII-ish
// summaries; multibyte emoji are only ever near the end of short SUMMARY lines.
function icsFoldLine(line) {
  if (line.length <= 74) return line;
  const parts = [];
  let rest = line;
  parts.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length) { parts.push(" " + rest.slice(0, 73)); rest = rest.slice(73); }
  return parts.join("\r\n");
}
function buildPayoffIcs(activeDebts, plan) {
  const CRLF = "\r\n";
  const stamp = icsDateStamp(new Date());
  const uidBase = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Snowball//Payoff Plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const addEvent = (uid, dateValue, summary) => {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${dateValue}`);
    lines.push(icsFoldLine(`SUMMARY:${icsEscapeText(summary)}`));
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  };
  // One all-day event per debt, ordered by payoff month for a tidy calendar.
  const ranked = [...activeDebts]
    .filter((d) => plan.payoffMonth[d.id])
    .sort((a, b) => plan.payoffMonth[a.id] - plan.payoffMonth[b.id]);
  ranked.forEach((d, i) => {
    const when = firstOfMonthAfter(plan.payoffMonth[d.id]);
    const name = d.name.trim() || "Untitled debt";
    addEvent(`snowball-debt-${i}-${uidBase}@snowball`, icsDateValue(when), `${name} paid off 🎉`);
  });
  // Final debt-free milestone on the debt-free date.
  const freeWhen = firstOfMonthAfter(plan.months);
  addEvent(`snowball-debtfree-${uidBase}@snowball`, icsDateValue(freeWhen), "Debt-free! 🎉");
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}
// Saves the .ics text as a download (Capacitor share on native, anchor
// elsewhere), mirroring downloadPdfBytes' cross-platform handling.
async function downloadIcs(text, filename) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    try {
      const { Filesystem } = window.Capacitor.Plugins;
      const { Share } = window.Capacitor.Plugins;
      const base64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
      const { uri } = await Filesystem.writeFile({ path: filename, data: base64, directory: "CACHE" });
      await Share.share({ title: filename, files: [uri] });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 4000); }
  } else {
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}
function buildCalendarExportCard(activeDebts, plan) {
  const card = el("div", "modeler-card");
  card.appendChild(txt("h4", "modeler-title", "Add your payoff plan to your calendar"));
  card.appendChild(txt("p", "hint", "Download an .ics file with an all-day reminder for each debt's payoff month and your debt-free date. Import it into any calendar app — nothing leaves your device."));

  const hasMilestones = !plan.neverPaysOff && Object.keys(plan.payoffMonth).length > 0;
  const row = el("div", "modeler-actions");
  const btn = txt("button", "btn ghost sm", "Add to calendar (.ics)"); btn.type = "button";
  btn.disabled = !hasMilestones;
  const status = el("div", "modeler-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  btn.onclick = async () => {
    if (btn.disabled) return;
    try {
      const ics = buildPayoffIcs(activeDebts, plan);
      await downloadIcs(ics, "snowball-payoff-plan.ics");
      status.textContent = "Calendar file ready.";
      announce("Calendar file ready.", false);
    } catch (e) {
      status.textContent = "Couldn't create the calendar file. Please try again.";
      announce("Couldn't create the calendar file.", true);
    }
  };
  row.appendChild(btn);
  card.appendChild(row);
  card.appendChild(status);
  return card;
}

// ── Biweekly accelerator (free) ────────────────────────────────────────────
// Models paying HALF the monthly amount every 2 weeks: 26 half-payments a year
// = 13 full payments = one extra monthly payment per year. We approximate that
// as a steady monthly extra equal to (one monthly payment ÷ 12), run the same
// pure simulateStrategy(), and compare to the base plan. The assumption is
// stated honestly in the copy. Transient — never writes state.
function buildBiweeklyCard(activeDebts, base, monthlyPay) {
  const card = el("div", "modeler-card");
  card.appendChild(txt("h4", "modeler-title", "Try paying biweekly"));
  card.appendChild(txt("p", "hint", "Paying half your monthly amount every two weeks adds up to one extra monthly payment a year. See what that does — biweekly ≈ one extra monthly payment a year."));

  const readout = el("div", "modeler-readout");
  readout.setAttribute("role", "status");
  readout.setAttribute("aria-live", "polite");

  const baseExtra = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
  // One extra monthly payment a year, spread evenly ≈ monthlyPay / 12 added on
  // top of whatever extra is already in the plan.
  const biweeklyBoost = monthlyPay / 12;
  const boostedExtra = Math.min(MAX_MONEY, baseExtra + biweeklyBoost);

  const renderOn = () => {
    const sim = simulateStrategy(activeDebts, state.strategy, boostedExtra);
    readout.innerHTML = "";
    if (sim.neverPaysOff) {
      readout.appendChild(txt("p", "modeler-msg", "Even paying biweekly, these debts don't clear within " + (CAP_MONTHS / 12) + " years at this payment level."));
      return;
    }
    const dateLabel = formatDate(addMonths(new Date(), sim.months));
    const monthsSaved = base.months - sim.months;
    const interestSaved = base.totalInterest - sim.totalInterest;
    const stats = el("div", "modeler-stats");
    stats.appendChild(whatIfStat(dateLabel, "Debt-free date"));
    stats.appendChild(whatIfStat(money(sim.totalInterest), "Total interest"));
    readout.appendChild(stats);
    if (monthsSaved >= 1 || interestSaved > 0.5) {
      const bits = [];
      if (monthsSaved >= 1) bits.push(`${monthsLabel(monthsSaved)} sooner`);
      if (interestSaved > 0.5) bits.push(`saving ${money(interestSaved)} in interest`);
      readout.appendChild(txt("p", "modeler-save", `Paying biweekly → debt-free ${dateLabel}${bits.length ? " (" + bits.join(", ") + ")" : ""}.`));
    } else {
      readout.appendChild(txt("p", "modeler-save muted", `Paying biweekly → debt-free ${dateLabel}. About the same as your current plan.`));
    }
  };

  const row = el("div", "modeler-actions");
  const toggle = txt("button", "btn ghost sm", "Show biweekly plan"); toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  let shown = false;
  toggle.onclick = () => {
    shown = !shown;
    toggle.setAttribute("aria-expanded", String(shown));
    if (shown) { renderOn(); toggle.textContent = "Hide biweekly plan"; }
    else { readout.innerHTML = ""; toggle.textContent = "Show biweekly plan"; }
  };
  row.appendChild(toggle);
  card.appendChild(row);
  card.appendChild(readout);
  return card;
}

// ── One-time windfall modeler (free) ───────────────────────────────────────
// The user names a lump sum + a month; we simulate applying that one-time extra
// to the highest-priority still-open debt in that month, on top of the current
// plan, and report the improved debt-free date + interest saved vs the base
// plan. Purely transient — nothing is written to state.
//
// simulateWithWindfall mirrors simulateStrategy exactly, adding a single
// one-time payment in the chosen month that rolls onto priority debts the same
// way the monthly extra does. Same CAP_MONTHS circuit-breaker.
function simulateWithWindfall(debts, strategy, extraPayment, lumpSum, applyMonth) {
  const active = debts.filter((d) => d.balance > 0.005).map((d) => ({ ...d }));
  const originalIndex = new Map(active.map((d, i) => [d.id, i]));
  const totalMonthlyBudget = extraPayment + active.reduce((s, d) => s + d.minPayment, 0);
  const totalStartBalance = active.reduce((s, d) => s + d.balance, 0);
  let totalInterest = 0;
  let month = 0;
  if (!active.length) return { months: 0, neverPaysOff: false, totalInterest: 0, totalStartBalance: 0 };

  while (active.some((d) => d.balance > 0.005) && month < CAP_MONTHS) {
    month++;
    active.forEach((d) => {
      if (d.balance > 0.005) {
        const interest = d.balance * (d.apr / 100 / 12);
        d.balance += interest;
        totalInterest += interest;
      }
    });

    let remaining = totalMonthlyBudget;
    active.forEach((d) => {
      if (d.balance > 0.005) {
        const pay = Math.min(d.minPayment, d.balance, Math.max(0, remaining));
        d.balance -= pay;
        remaining -= pay;
      }
    });

    // One-time windfall added to this month's rollover budget.
    if (month === applyMonth) remaining += lumpSum;

    const order = orderDebts(active.filter((d) => d.balance > 0.005), strategy, originalIndex);
    for (const d of order) {
      if (remaining <= 0) break;
      const pay = Math.min(remaining, d.balance);
      d.balance -= pay;
      remaining -= pay;
    }
  }

  return {
    months: month,
    neverPaysOff: active.some((d) => d.balance > 0.005),
    totalInterest,
    totalStartBalance,
  };
}
// ── "What this purchase really costs" (free) ────────────────────────────────
// The windfall modeler with the sign flipped: add a would-be purchase to a debt,
// re-run the sim, and show the true cost (price + the extra interest it triggers)
// and how far it pushes the debt-free date back. A friction tool for the moment
// in the store — framed as a trade, never as shame. Transient; never writes state.
function buildPurchaseCostCard(activeDebts, strategy, extra, base) {
  const card = el("div", "modeler-card");
  card.appendChild(txt("h4", "modeler-title", "What this purchase really costs"));
  card.appendChild(txt("p", "hint", "Tempted to put something on a card? See what it truly costs once interest is added — and how far it pushes your debt-free date. Just a preview; nothing is saved."));

  const grid = el("div", "modeler-inputs");
  const amtWrap = el("div", "field");
  const amtId = `f${++fieldIdSeq}`;
  const amtLabel = txt("label", "field-label", "Purchase amount"); amtLabel.htmlFor = amtId;
  amtWrap.appendChild(amtLabel);
  const amtInput = el("input"); amtInput.id = amtId; amtInput.type = "text"; amtInput.inputMode = "decimal"; amtInput.placeholder = "400";
  amtInput.setAttribute("aria-label", "Purchase amount");
  amtWrap.appendChild(amtInput);
  grid.appendChild(amtWrap);

  let cardSelect = null;
  if (activeDebts.length > 1) {
    const cWrap = el("div", "field");
    const cId = `f${++fieldIdSeq}`;
    const cLabel = txt("label", "field-label", "Put it on"); cLabel.htmlFor = cId;
    cWrap.appendChild(cLabel);
    cardSelect = el("select"); cardSelect.id = cId;
    activeDebts.forEach((d, i) => { const o = el("option"); o.value = String(i); o.textContent = (d.name || "").trim() || `Debt ${i + 1}`; cardSelect.appendChild(o); });
    cWrap.appendChild(cardSelect);
    grid.appendChild(cWrap);
  }
  card.appendChild(grid);

  const readout = el("div", "modeler-readout");
  readout.setAttribute("role", "status"); readout.setAttribute("aria-live", "polite");
  const rowa = el("div", "modeler-actions");
  const btn = txt("button", "btn sm", "See the true cost"); btn.type = "button";
  btn.onclick = () => {
    const amount = safeNumber(amtInput.value, { min: 0, max: MAX_MONEY });
    readout.innerHTML = "";
    if (amount <= 0) { readout.appendChild(txt("p", "hint", "Enter an amount to see its true cost.")); return; }
    if (base.neverPaysOff) { readout.appendChild(txt("p", "hint", "Add an extra payment first so we can compare the true cost.")); return; }
    const idx = cardSelect ? Math.max(0, Math.min(activeDebts.length - 1, parseInt(cardSelect.value, 10) || 0)) : 0;
    const withBuy = activeDebts.map((d, i) => (i === idx ? { ...d, balance: d.balance + amount } : { ...d }));
    const after = simulateStrategy(withBuy, strategy, extra);
    const extraInterest = Math.max(0, after.totalInterest - base.totalInterest);
    const trueCost = amount + extraInterest;
    const delay = Math.max(0, after.months - base.months);
    const p = el("p", "modeler-result");
    p.appendChild(document.createTextNode("That "));
    const b1 = el("b"); b1.textContent = money(amount); p.appendChild(b1);
    p.appendChild(document.createTextNode(" really costs you "));
    const b2 = el("b"); b2.textContent = money(trueCost); p.appendChild(b2);
    p.appendChild(document.createTextNode(` — ${money(extraInterest)} of it is extra interest`));
    p.appendChild(document.createTextNode(delay >= 1 ? `, and pushes your debt-free date back about ${monthsLabel(delay)}.` : "."));
    readout.appendChild(p);
    readout.appendChild(txt("p", "hint", "No judgment — just the trade, so it's your call with eyes open."));
  };
  rowa.appendChild(btn); rowa.appendChild(readout);
  card.appendChild(rowa);
  return card;
}

// ── Rough-month triage (free) ───────────────────────────────────────────────
// "I can't pay full this month." Enter what you CAN pay; we model one reduced
// month (via simulateStrategy's firstMonthBudget) and answer calmly with the
// real cost — plus a blunt heads-up if it won't even cover interest. Meets you
// at the bad month without shame. Transient; never writes state.
function buildRoughMonthCard(activeDebts, strategy, extra, base) {
  const card = el("div", "modeler-card");
  card.appendChild(txt("h4", "modeler-title", "Tight month? See what happens"));
  card.appendChild(txt("p", "hint", "Life happens. If you can only pay part of your plan this one month, see the real impact — it's usually smaller than the stress. Nothing is saved."));
  const usualBudget = extra + activeDebts.reduce((s, d) => s + d.minPayment, 0);
  const minsOnly = activeDebts.reduce((s, d) => s + d.minPayment, 0);

  const grid = el("div", "modeler-inputs");
  const amtWrap = el("div", "field");
  const amtId = `f${++fieldIdSeq}`;
  const amtLabel = txt("label", "field-label", "What you can pay this month"); amtLabel.htmlFor = amtId;
  amtWrap.appendChild(amtLabel);
  const amtInput = el("input"); amtInput.id = amtId; amtInput.type = "text"; amtInput.inputMode = "decimal";
  amtInput.placeholder = String(Math.round(usualBudget));
  amtInput.setAttribute("aria-label", "Amount you can pay this month");
  amtWrap.appendChild(amtInput);
  grid.appendChild(amtWrap);
  card.appendChild(grid);
  card.appendChild(txt("p", "hint modeler-subhint", `Your usual plan is about ${money(usualBudget)} a month.`));

  const readout = el("div", "modeler-readout");
  readout.setAttribute("role", "status"); readout.setAttribute("aria-live", "polite");
  const rowb = el("div", "modeler-actions");
  const btn = txt("button", "btn sm", "Show me"); btn.type = "button";
  btn.onclick = () => {
    const canPay = safeNumber(amtInput.value, { min: 0, max: MAX_MONEY });
    readout.innerHTML = "";
    if (canPay <= 0) { readout.appendChild(txt("p", "hint", "Enter what you can pay this month.")); return; }
    if (canPay >= usualBudget) { readout.appendChild(txt("p", "modeler-result", "That's your full plan — you're right on track this month. 💪")); return; }
    if (base.neverPaysOff) { readout.appendChild(txt("p", "hint", "Add an extra payment first so we can compare.")); return; }
    const rough = simulateStrategy(activeDebts, strategy, extra, { firstMonthBudget: canPay });
    const delayMonths = Math.max(0, rough.months - base.months);
    const extraInterest = Math.max(0, rough.totalInterest - base.totalInterest);
    const monthInterest = activeDebts.reduce((s, d) => s + Math.max(0, d.balance) * (Math.max(0, d.apr) / 100 / 12), 0);

    const p = el("p", "modeler-result");
    p.appendChild(document.createTextNode("Paying "));
    const b1 = el("b"); b1.textContent = money(canPay); p.appendChild(b1);
    p.appendChild(document.createTextNode(" this month "));
    if (delayMonths < 1 && extraInterest < 1) {
      p.appendChild(document.createTextNode("barely moves your plan — you're fine. Get back to it next month."));
    } else {
      p.appendChild(document.createTextNode("adds about "));
      const b2 = el("b"); b2.textContent = money(extraInterest); p.appendChild(b2);
      p.appendChild(document.createTextNode(" in interest"));
      if (delayMonths >= 1) p.appendChild(document.createTextNode(` and ${monthsLabel(delayMonths)} to your date`));
      p.appendChild(document.createTextNode(". You're okay — one month won't undo your progress."));
    }
    readout.appendChild(p);
    // Blunt-but-kind heads-up when this month's payment can't cover the interest.
    if (canPay < monthInterest - 0.5) {
      const warn = txt("p", "modeler-warn", `Heads up: ${money(canPay)} won't cover this month's ~${money(monthInterest)} in interest, so balances will tick up slightly. If you can reach ${money(minsOnly)} (your minimums), you'll at least hold steady.`);
      readout.appendChild(warn);
    }
  };
  rowb.appendChild(btn); rowb.appendChild(readout);
  card.appendChild(rowb);
  return card;
}

function buildWindfallCard(activeDebts, base) {
  const card = el("div", "modeler-card");
  card.appendChild(txt("h4", "modeler-title", "Model a one-time windfall"));
  card.appendChild(txt("p", "hint", "Expecting a bonus, tax refund, or gift? See how a single extra payment in one month moves your debt-free date. This is a preview — nothing is saved."));

  const grid = el("div", "modeler-inputs");

  // Amount input.
  const amtWrap = el("div", "field");
  const amtId = `f${++fieldIdSeq}`;
  const amtLabel = txt("label", "field-label", "Lump-sum amount");
  amtLabel.htmlFor = amtId;
  amtWrap.appendChild(amtLabel);
  const amtInput = el("input");
  amtInput.id = amtId;
  amtInput.type = "text";
  amtInput.inputMode = "decimal";
  amtInput.placeholder = "2,000";
  amtInput.setAttribute("aria-label", "Lump-sum amount to apply");
  amtWrap.appendChild(amtInput);
  grid.appendChild(amtWrap);

  // Month picker.
  const mWrap = el("div", "field");
  const mId = `f${++fieldIdSeq}`;
  const mLabel = txt("label", "field-label", "Apply in");
  mLabel.htmlFor = mId;
  mWrap.appendChild(mLabel);
  const mInput = el("input");
  mInput.id = mId;
  mInput.type = "month";
  const now = new Date();
  const minMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  mInput.min = minMonth;
  mInput.value = minMonth;
  mWrap.appendChild(mInput);
  grid.appendChild(mWrap);

  card.appendChild(grid);

  const readout = el("div", "modeler-readout");
  readout.setAttribute("role", "status");
  readout.setAttribute("aria-live", "polite");

  const row = el("div", "modeler-actions");
  const btn = txt("button", "btn sm", "See the effect"); btn.type = "button";
  btn.onclick = () => {
    const lump = safeNumber(amtInput.value, { min: 0, max: MAX_MONEY });
    readout.innerHTML = "";
    if (lump <= 0) {
      readout.appendChild(txt("p", "modeler-msg", "Enter a lump-sum amount to preview its effect."));
      return;
    }
    // Months from now (1-based) for the chosen month. Default/earliest is this
    // month → applyMonth 1 (the first simulated month).
    const applyMonth = monthOffsetFromNow(mInput.value);
    const baseExtra = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
    const sim = simulateWithWindfall(activeDebts, state.strategy, baseExtra, lump, applyMonth);
    if (sim.neverPaysOff) {
      readout.appendChild(txt("p", "modeler-msg", `Even a ${money(lump)} payment doesn't clear these debts within ${CAP_MONTHS / 12} years at this payment level.`));
      return;
    }
    const dateLabel = formatDate(addMonths(new Date(), sim.months));
    const monthsSaved = base.months - sim.months;
    const interestSaved = base.totalInterest - sim.totalInterest;
    const applyLabel = formatDate(addMonths(new Date(), applyMonth));
    const stats = el("div", "modeler-stats");
    stats.appendChild(whatIfStat(dateLabel, "Debt-free date"));
    stats.appendChild(whatIfStat(money(sim.totalInterest), "Total interest"));
    readout.appendChild(stats);
    if (monthsSaved >= 1 || interestSaved > 0.5) {
      const bits = [];
      if (monthsSaved >= 1) bits.push(`debt-free ${monthsLabel(monthsSaved)} sooner`);
      if (interestSaved > 0.5) bits.push(`saving ${money(interestSaved)} in interest`);
      readout.appendChild(txt("p", "modeler-save", `A ${money(lump)} payment in ${applyLabel} → ${bits.join(", ")}.`));
    } else {
      readout.appendChild(txt("p", "modeler-save muted", `A ${money(lump)} payment in ${applyLabel} barely changes this plan at your current payment level.`));
    }
  };
  row.appendChild(btn);
  card.appendChild(row);
  card.appendChild(readout);
  return card;
}

// ── Refinance / balance-transfer modeler (Pro) ─────────────────────────────
// Pick one debt, name a NEW APR and an optional transfer fee (flat $ or % of
// that debt's balance). We clone the debts, swap that one debt's apr to the new
// rate and add the fee onto its balance, then re-run the SAME pure
// simulateStrategy() with everything else held constant — same strategy, same
// extra payment, same other debts. Compare the resulting debt-free date and
// total interest to the base plan to show whether the move actually saves money
// after the fee. Purely transient — reads state, clones, never writes anything.
//
// GATE: the "See the effect" action is Pro. Free users see the card but running
// it opens the existing paywall via gateProAction() with a resume intent.
function simulateRefinance(activeDebts, strategy, extraPayment, debtId, newApr, feeAmount) {
  // Clone every debt; on the chosen one, swap the APR and add the fee to the
  // balance (a balance transfer typically capitalizes the fee onto the new
  // balance). All other debts are untouched.
  const debts = activeDebts.map((d) =>
    d.id === debtId
      ? { ...d, apr: newApr, balance: d.balance + feeAmount }
      : { ...d }
  );
  return simulateStrategy(debts, strategy, extraPayment);
}
function buildRefinanceCard(activeDebts, base) {
  const card = el("div", "modeler-card");
  card.appendChild(txt("h4", "modeler-title", "Model a refinance or balance transfer"));
  card.appendChild(txt("p", "hint", "Thinking of moving a debt to a lower rate? Pick the debt, enter the new APR and any transfer fee, and see whether it actually saves money after the fee. This is a preview — nothing is saved."));

  const grid = el("div", "modeler-inputs");

  // Debt picker.
  const debtWrap = el("div", "field");
  const debtId = `f${++fieldIdSeq}`;
  const debtLabel = txt("label", "field-label", "Which debt");
  debtLabel.htmlFor = debtId;
  debtWrap.appendChild(debtLabel);
  const debtSelect = el("select");
  debtSelect.id = debtId;
  debtSelect.setAttribute("aria-label", "Debt to refinance");
  activeDebts.forEach((d) => {
    const opt = el("option");
    opt.value = d.id;
    // textContent — debt name is user data, never innerHTML.
    opt.textContent = `${d.name.trim() || "Untitled debt"} — ${money(d.balance)} @ ${d.apr}%`;
    debtSelect.appendChild(opt);
  });
  debtWrap.appendChild(debtSelect);
  grid.appendChild(debtWrap);

  // New APR input.
  const aprWrap = el("div", "field");
  const aprId = `f${++fieldIdSeq}`;
  const aprLabel = txt("label", "field-label", "New APR (%)");
  aprLabel.htmlFor = aprId;
  aprWrap.appendChild(aprLabel);
  const aprInput = el("input");
  aprInput.id = aprId;
  aprInput.type = "text";
  aprInput.inputMode = "decimal";
  aprInput.placeholder = "0";
  aprInput.setAttribute("aria-label", "New annual percentage rate");
  aprWrap.appendChild(aprInput);
  grid.appendChild(aprWrap);

  // Fee type picker.
  const feeTypeWrap = el("div", "field");
  const feeTypeId = `f${++fieldIdSeq}`;
  const feeTypeLabel = txt("label", "field-label", "Transfer fee");
  feeTypeLabel.htmlFor = feeTypeId;
  feeTypeWrap.appendChild(feeTypeLabel);
  const feeTypeSelect = el("select");
  feeTypeSelect.id = feeTypeId;
  feeTypeSelect.setAttribute("aria-label", "Transfer fee type");
  [["percent", "% of balance"], ["flat", "Flat $"]].forEach(([val, lbl]) => {
    const opt = el("option");
    opt.value = val;
    opt.textContent = lbl;
    feeTypeSelect.appendChild(opt);
  });
  feeTypeWrap.appendChild(feeTypeSelect);
  grid.appendChild(feeTypeWrap);

  // Fee amount input.
  const feeWrap = el("div", "field");
  const feeId = `f${++fieldIdSeq}`;
  const feeLabel = txt("label", "field-label", "Fee amount");
  feeLabel.htmlFor = feeId;
  feeWrap.appendChild(feeLabel);
  const feeInput = el("input");
  feeInput.id = feeId;
  feeInput.type = "text";
  feeInput.inputMode = "decimal";
  feeInput.placeholder = "3";
  feeInput.setAttribute("aria-label", "Transfer fee amount");
  feeWrap.appendChild(feeInput);
  grid.appendChild(feeWrap);

  card.appendChild(grid);

  const readout = el("div", "modeler-readout");
  readout.setAttribute("role", "status");
  readout.setAttribute("aria-live", "polite");

  const runModel = () => {
    readout.innerHTML = "";
    const chosen = activeDebts.find((d) => d.id === debtSelect.value) || activeDebts[0];
    if (!chosen) {
      readout.appendChild(txt("p", "modeler-msg", "Add a debt with a balance to model a refinance."));
      return;
    }
    const newApr = safeNumber(aprInput.value, { min: 0, max: 1000 });
    const feeRaw = safeNumber(feeInput.value, { min: 0, max: MAX_MONEY });
    // Fee: either a flat dollar amount, or a percentage of the chosen debt's
    // current balance. Percent is capped so a fat-fingered "300" can't invent a
    // wild balance.
    const feeAmount = feeTypeSelect.value === "flat"
      ? feeRaw
      : Math.min(MAX_MONEY, chosen.balance * (Math.min(feeRaw, 100) / 100));

    const baseExtra = safeNumber(state.extraPayment, { min: 0, max: MAX_MONEY });
    const sim = simulateRefinance(activeDebts, state.strategy, baseExtra, chosen.id, newApr, feeAmount);

    const debtName = chosen.name.trim() || "this debt";
    if (sim.neverPaysOff) {
      readout.appendChild(txt("p", "modeler-msg", `Even after refinancing, these debts don't clear within ${CAP_MONTHS / 12} years at this payment level.`));
      return;
    }

    const dateLabel = formatDate(addMonths(new Date(), sim.months));
    // Interest saved is the base plan's total interest minus the refinanced
    // plan's. Because the fee is capitalized into the balance, the refinanced
    // plan's total interest already reflects paying interest on the fee too —
    // so this figure is the true, fee-inclusive net.
    const interestSaved = base.totalInterest - sim.totalInterest;
    const stats = el("div", "modeler-stats");
    stats.appendChild(whatIfStat(dateLabel, "New debt-free date"));
    stats.appendChild(whatIfStat(money(sim.totalInterest), "Total interest"));
    readout.appendChild(stats);

    const feeNote = feeAmount > 0.5 ? ` (after a ${money(feeAmount)} fee)` : "";
    if (interestSaved > 0.5) {
      readout.appendChild(txt("p", "modeler-save", `Refinancing ${debtName} to ${newApr}%${feeNote} saves you about ${money(interestSaved)} in interest.`));
    } else if (interestSaved < -0.5) {
      // Net negative — the fee (and/or a not-actually-lower rate) costs more.
      readout.appendChild(txt("p", "modeler-save muted", `The ${feeAmount > 0.5 ? money(feeAmount) + " fee" : "new rate"} outweighs the savings here — refinancing ${debtName} would cost about ${money(-interestSaved)} more in interest.`));
    } else {
      readout.appendChild(txt("p", "modeler-save muted", `Refinancing ${debtName} to ${newApr}%${feeNote} barely changes what you pay — about the same either way.`));
    }
  };

  const row = el("div", "modeler-actions");
  const btn = txt("button", "btn sm", "See the effect"); btn.type = "button";
  // GATE: Pro action. Free users get the paywall (with this run as the
  // resume-on-unlock intent); Pro users run the model. Same gate every other
  // Pro surface uses — no new mechanism.
  btn.onclick = () => gateProAction(btn, { reason: "refinance" }, runModel);
  row.appendChild(btn);
  card.appendChild(row);
  card.appendChild(readout);
  return card;
}
// Whole months from the start of the current month to the start of the picked
// YYYY-MM month, clamped to at least 1 (this month = the first simulated
// month). Malformed input falls back to month 1.
function monthOffsetFromNow(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!m) return 1;
  const now = new Date();
  const diff = (parseInt(m[1], 10) - now.getFullYear()) * 12 + (parseInt(m[2], 10) - 1 - now.getMonth());
  return Math.max(1, diff + 1);
}

// Reads the live theme's chart colors from the CSS custom properties so the
// canvas retints with the rest of the UI when the theme flips (the tokens are
// defined in :root and overridden under [data-theme="dark"]).
function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    grid: pick("--chart-grid", "#e7e8ee"),
    label: pick("--chart-label", "#6b7280"),
    snowball: pick("--chart-snowball", "#0e7490"),
    avalanche: pick("--chart-avalanche", "#c2410c"),
  };
}

// True when two balance-over-time series are visually indistinguishable: same
// number of points and the same (month, balance) at each step, within a
// sub-cent tolerance so floating-point noise doesn't read as "different."
function sameTrajectory(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].month !== b[i].month) return false;
    if (Math.abs((a[i].totalBalance || 0) - (b[i].totalBalance || 0)) > 0.005) return false;
  }
  return true;
}

function drawChart(canvas, seriesA, seriesB) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(280, rect.width), h = 220;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const colors = chartColors();

  const maxMonth = Math.max(seriesA[seriesA.length - 1]?.month || 0, seriesB[seriesB.length - 1]?.month || 0, 1);
  const maxBalance = Math.max(seriesA[0]?.totalBalance || 0, seriesB[0]?.totalBalance || 0, 1);
  const padL = 44, padB = 24, padT = 10, padR = 10;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const x = (m) => padL + (m / maxMonth) * plotW;
  const y = (bal) => padT + plotH - (bal / maxBalance) * plotH;

  ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
  }
  ctx.fillStyle = colors.label; ctx.font = "10px -apple-system, sans-serif"; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const val = maxBalance - (maxBalance / 4) * i;
    ctx.fillText(money(val), padL - 6, padT + (plotH / 4) * i + 3);
  }

  // Draws an end-of-line marker dot so a single-point series (a debt paid
  // off instantly) is still visible — moveTo with no lineTo strokes
  // nothing — and so a strategy that finishes early doesn't just look
  // "cut off" mid-chart with no indication it actually reached zero.
  function drawLine(series, color) {
    if (!series.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.beginPath();
    let lastX, lastY;
    series.forEach((pt, i) => {
      const px = x(pt.month), py = y(pt.totalBalance);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      lastX = px; lastY = py;
    });
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  drawLine(seriesB, colors.avalanche);
  drawLine(seriesA, colors.snowball);
}

// ── Theme control (light / dark / system) ─────────────────────────────────
// The pre-paint inline script in index.html already set the initial
// data-theme from this same key, so this only handles live toggling +
// following the OS when the pref is "system"/unset. Persisted under
// "snowball.theme"; values "light" | "dark" | "system" (default = system).
const THEME_KEY = "snowball.theme";
const themeMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function readThemePref() {
  try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; }
}
function effectiveDark(pref) {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return !!(themeMedia && themeMedia.matches); // system/unset
}
function applyTheme(pref) {
  if (effectiveDark(pref)) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  // The chart is drawn on a canvas, so it can't inherit the CSS token change —
  // re-render the results so drawChart() repaints with theme-appropriate ink.
  if (window.__snowballRefresh) window.__snowballRefresh();
}
// Cycles the three states so EVERY click visibly changes the rendered theme
// (LocalResume-harmonized). From "system"/unset the first click flips to the
// OPPOSITE of what's currently shown on screen — so a click never lands on the
// same-looking theme (the old "system"→"light" on a light OS no-op). After that
// it's dark → light → system, keeping all three reachable.
function cycleTheme() {
  const cur = readThemePref();
  const renderedDark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = cur === "system" ? (renderedDark ? "light" : "dark")
    : cur === "dark" ? "light"
    : "system";
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private-browsing — session-only */ }
  applyTheme(next);
  announce(`Theme: ${next === "system" ? "follow system" : next}`, false);
}
(function initTheme() {
  const btn = $("#themeToggle");
  if (btn) btn.onclick = cycleTheme;
  // Live-update while the pref is "system"/unset and the OS scheme changes.
  if (themeMedia) {
    const onChange = () => { if (readThemePref() === "system") applyTheme("system"); };
    if (themeMedia.addEventListener) themeMedia.addEventListener("change", onChange);
    else if (themeMedia.addListener) themeMedia.addListener(onChange); // older Safari
  }
})();

// ── Boot ─────────────────────────────────────────────────────────────────
const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
$("#logo").onclick = scrollTop;
$("#logo").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scrollTop(); }
});
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (window.__snowballRefresh) window.__snowballRefresh(); }, 150);
});

// ── Router wiring ──────────────────────────────────────────────────────────
// Re-render on every hash change (nav clicks, back/forward, deep-links). The
// nav items are real <a href="#/…"> links, so the browser handles history and
// the back button; we only react to the resulting hashchange. Normalize an
// empty/garbage hash to the default route once at boot so a fresh visit and a
// deep-link both land on a valid view.
window.addEventListener("hashchange", () => {
  buildApp();
  // Bring the freshly-mounted view into view on navigation (not on the initial
  // load), matching the single-page feel; respects reduced-motion via 'auto'.
  window.scrollTo({ top: 0, behavior: "auto" });
});
if (!ROUTES.some((r) => location.hash === "#/" + r)) {
  // replace (not push) so the normalized default doesn't add a history entry.
  try { history.replaceState(null, "", "#/" + DEFAULT_ROUTE); } catch (e) { location.hash = "#/" + DEFAULT_ROUTE; }
}
buildApp();
// Boot entitlement check. Billing.shouldCheckAtBoot() returns true only when this
// browser might already own Pro (a stored restore code, a verified-before "owner"
// flag, or an attempted-but-stranded purchase). A brand-new visitor returns false,
// so fresh loads still make ZERO billing network calls — their debt data stays
// fully on-device and we only touch the network when they engage a Pro action.
//
// This fixes the "paid, then closed the tab before the code minted, stays locked"
// case: the attempted-purchase flag re-checks entitlement here and unlocks. When a
// refresh finds Pro but there's no restore code, surface the self-heal banner so
// the owner can create a code for their other devices.
(async () => {
  try {
    if (Billing.shouldCheckAtBoot()) {
      const pro = await Billing.refreshProStatus();
      if (pro) {
        markWasProIfActive();
        buildApp();
        updateLicenseFooterLink();
        updateRefundFooterLink();
        updateSideProCard();
        if (!Billing.getRestoreCode()) maybeShowSelfHealNag(); else maybeShowSaveNag();
      } else {
        // Verified not-Pro after a boot check that this browser was eligible
        // for. If it WAS a known owner, this is a real revocation (refund /
        // expiry) — show the calm, one-time, non-destructive access-ended
        // notice and re-gate Pro output. (Offline blips fail OPEN inside
        // Billing, so isPro() stays true and this branch won't misfire.)
        handleAccessStopIfRevoked();
      }
    }
  } catch (e) { /* offline / flaky — Billing fails open for known owners internally */ }
})();
if (IS_NATIVE) {
  // iOS: no typed restore code — the footer entry becomes Apple's "Restore Purchases",
  // re-syncing this Apple ID's receipt with the App Store.
  const footerRestore = $("#footerRestoreLink");
  footerRestore.textContent = "Restore Purchases";
  footerRestore.onclick = async () => {
    const prev = footerRestore.textContent;
    footerRestore.disabled = true; footerRestore.textContent = "Restoring…";
    let res;
    try { res = await Billing.restorePurchases(); }
    catch (e) { console.error("Snowball: restore threw", e); res = { ok: false }; }
    footerRestore.disabled = false; footerRestore.textContent = prev;
    if (res && res.ok) {
      announce("Welcome back — Pro is unlocked on this device.", false);
      showToast("Welcome back — Pro is unlocked on this device.");
      refreshAfterProChange();
      runPendingProIntent();
    } else {
      showToast("No previous purchase found for this Apple Account.");
    }
  };
} else {
  $("#footerRestoreLink").onclick = () => showRestoreEntryModal();
}
$("#footerLicenseLink").onclick = () => showLicenseCardModal();
$("#footerRefundLink").onclick = () => showRefundModal();
updateRefundFooterLink();
updateSideProCard();
// If this browser is already known-Pro on the synchronous fast path (a verified
// owner from a prior session), record it now so a future verified revocation is
// recognizable even if no refresh runs this session.
markWasProIfActive();
$("#footerBackupLink").onclick = () => exportVault();
const vaultInput = $("#vaultFileInput");
$("#footerImportLink").onclick = () => vaultInput.click();
vaultInput.addEventListener("change", () => {
  const f = vaultInput.files && vaultInput.files[0];
  vaultInput.value = ""; // so re-picking the same file re-fires change
  importVault(f);
});
maybeShowSaveNag();


/* Offline support (progressive enhancement): register the service worker ONLY
   on the real https web deployment. Never in the Capacitor native shell
   (localhost) or local dev, where assets already load offline and a SW could
   interfere. Fails silently. */
(function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  var h = location.hostname;
  var webOK = location.protocol === "https:" && h !== "localhost" && h !== "127.0.0.1" && !h.endsWith(".local");
  if (!webOK) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
})();

// ── QR deep-link restore (?restore=CODE) ───────────────────────────────────
// The license card's QR encodes https://mysnowballapp.com/?restore=<code> so a
// phone camera scan opens the app and restores Pro in one step (a bare-text QR
// would just land the user in a web search). Handle the param once, then scrub
// it from the URL and history — the code is a secret and shouldn't linger there.
(async () => {
  let code = null;
  try { code = new URLSearchParams(location.search).get("restore"); } catch (e) {}
  if (!code || !code.trim()) return;
  try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
  const normalized = formatRestoreCodeInput(code);
  const proceed = async () => {
    let res;
    try { res = await Billing.restoreWithCode(normalized); }
    catch (e) { res = { ok: false }; }
    if (res && res.ok) {
      announce("Welcome back — Pro is unlocked on this device.", false);
      showToast("Welcome back — Pro is unlocked on this device.");
      refreshAfterProChange();
      runPendingProIntent();
    } else {
      // Couldn't restore from the scan (offline, refunded, or an odd code) — open
      // the restore modal prefilled so the user can see the code and retry.
      showRestoreEntryModal();
      const inp = document.querySelector(".restore-code-input");
      if (inp) inp.value = normalized || String(code).trim();
    }
  };
  // A successful restore ADOPTS the scanned identity: rememberIdentity() overwrites
  // the stored code, and the boot nag stays quiet because code_ack is already set —
  // so opening someone else's link would silently and permanently discard this
  // device's own code. If a DIFFERENT code is already saved here, ask before
  // switching. Re-scanning your own card (same code) stays one-step seamless.
  let existing = null;
  try { existing = Billing.getRestoreCode(); } catch (e) {}
  if (existing && existing !== normalized) {
    const backdrop = el("div", "modal-backdrop");
    const modal = el("div", "modal pro-modal");
    modal.appendChild(txt("h3", null, "Keep your current Pro code?"));
    modal.appendChild(txt("p", "hint", "This device already has a Pro code saved:"));
    const box = el("div", "restore-code-box");
    box.appendChild(txt("div", "restore-code-value", existing));
    modal.appendChild(box);
    modal.appendChild(txt("p", "hint",
      "The link you opened restores a different code. Switching replaces the code saved on this device — if you haven't saved your license card, the current code can't be recovered here."));
    const keepBtn = txt("button", "btn big", "Keep my current code"); keepBtn.type = "button";
    const switchBtn = txt("button", "btn ghost", "Switch to the new code"); switchBtn.type = "button";
    const actions = el("div", "pro-actions"); actions.append(keepBtn, switchBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const a11y = makeModalAccessible(backdrop, modal, { escCloses: true });
    keepBtn.onclick = () => a11y.close();
    switchBtn.onclick = () => { a11y.close(); proceed(); };
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) a11y.close(); });
    return;
  }
  await proceed();
})();
