'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal';
import Pill from '../../components/Pill';
import EmptyState from '../../components/EmptyState';
import { formatRelativeTime } from '../../lib/format';

/**
 * Shared helpers for the Site Policy page. Exported here (rather than a
 * separate module) so AgentRulesPanel can reuse the pill + time helpers.
 */

// Client-side normalization preview. The server (site-policy.normalizeDomain)
// stays authoritative; this only tidies obvious input (scheme, path, port,
// leading www.) so the user sees what will be saved.
export function normalizeDomainInput(input) {
  if (typeof input !== 'string') return '';
  let raw = input.trim().toLowerCase();
  if (raw.length === 0) return '';
  if (raw === '*') return '*';
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  raw = raw.split('/')[0].split(':')[0];
  if (raw.startsWith('www.')) raw = raw.slice(4);
  return raw;
}

// Toast text for a failed API call: server reason, then error, then message.
export function apiErrorMessage(err, fallback) {
  const payload = err && err.payload && typeof err.payload === 'object' ? err.payload : null;
  return (payload && (payload.reason || payload.error)) || (err && err.message) || fallback;
}

// Lowercase variant of formatRelativeTime for inline use ("added just now").
export function relTime(value) {
  const s = formatRelativeTime(value);
  if (s === 'Just now' || s === 'Yesterday') return s.toLowerCase();
  return s;
}

export function DecisionPill({ decision }) {
  return decision === 'allow'
    ? <Pill state="active" label="Allow" />
    : <Pill state="danger" label="Block" />;
}

/**
 * AddRuleForm — domain input + Allow/Block radios. Ids come from useId() so
 * two forms on the page never collide.
 *
 * Props:
 *   allowWildcard — when false, any `*` shows an inline error and blocks submit.
 *   hint          — optional helper line under the input.
 *   onSubmit({domain, decision}) → Promise<boolean>; true clears the form.
 *   onCancel, busy, defaultDecision, submitLabel
 */
export function AddRuleForm({
  allowWildcard = false,
  hint = null,
  onSubmit,
  onCancel,
  busy = false,
  defaultDecision = 'block',
  submitLabel = 'Add rule',
  inputRef = null,
}) {
  const reactId = useId();
  const domainId = `wp-site-policy-domain-${reactId}`;
  const hintId = `wp-site-policy-domain-hint-${reactId}`;
  const errorId = `wp-site-policy-domain-error-${reactId}`;
  const radioName = `wp-site-policy-decision-${reactId}`;
  const [domain, setDomain] = useState('');
  const [decision, setDecision] = useState(defaultDecision);

  const wildcardError = !allowWildcard && domain.includes('*')
    ? 'Wildcards are per-agent only. Add them under Per-agent rules.'
    : null;
  const normalized = normalizeDomainInput(domain);
  const valid = normalized === '*'
    ? allowWildcard
    : normalized.length > 0 && normalized.includes('.');
  const canSubmit = valid && !wildcardError && !busy;
  const showPreview = normalized && normalized !== domain.trim().toLowerCase();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    const ok = await onSubmit({ domain: normalized, decision });
    if (ok) setDomain('');
  }

  const describedBy = [hint ? hintId : null, wildcardError ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <form className="wp-site-policy-form" onSubmit={handleSubmit}>
      <div className="wp-site-policy-field">
        <label htmlFor={domainId} className="wp-site-policy-field-label">Domain</label>
        <input
          ref={inputRef}
          id={domainId}
          className="wp-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="example.com"
          value={domain}
          aria-invalid={wildcardError ? 'true' : undefined}
          aria-describedby={describedBy}
          onChange={(e) => setDomain(e.target.value)}
          autoFocus
        />
        {wildcardError ? (
          <span id={errorId} className="wp-site-policy-field-error">{wildcardError}</span>
        ) : null}
        {hint ? <span id={hintId} className="wp-site-policy-field-hint">{hint}</span> : null}
        {!wildcardError && showPreview ? (
          <span className="wp-site-policy-field-hint">
            Will be saved as <span className="wp-mono">{normalized}</span>.
          </span>
        ) : null}
      </div>
      <div className="wp-site-policy-radios" role="radiogroup" aria-label="Decision">
        <label className="wp-site-policy-radio">
          <input
            type="radio"
            name={radioName}
            value="allow"
            checked={decision === 'allow'}
            onChange={() => setDecision('allow')}
          />
          <span>Allow</span>
        </label>
        <label className="wp-site-policy-radio">
          <input
            type="radio"
            name={radioName}
            value="block"
            checked={decision === 'block'}
            onChange={() => setDecision('block')}
          />
          <span>Block</span>
        </label>
      </div>
      <div className="wp-site-policy-actions" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="wp-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="wp-btn wp-btn-primary" disabled={!canSubmit}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

const PAGE_SIZE = 25;

const GROUP_LABELS = {
  userAllow: 'Allowed by you',
  userBlock: 'Blocked by you',
  signed: 'Signed block list',
};

const byDomain = (a, b) => a.domain.localeCompare(b.domain);

/**
 * RulesModal — one reusable modal for both the global block list and a
 * single agent's rules, driven by `scope`.
 *
 * Internal state machine: `view` is 'list' | 'add' | 'confirmDelete'. Each
 * view replaces the previous one — there is never an inline form rendered
 * above the list. The modal shell is a fixed-height flex column (header +
 * footer fixed, only the body scrolls) so switching to the add view never
 * grows the modal or introduces an outer scrollbar.
 *
 * Global scope keeps the original GlobalListModal behavior: groups (your
 * allows, your blocks, the read-only signed list with an "Overridden by
 * your allow" note), search, 25-row paging, `+ Add global rule`, and
 * per-row delete via the in-place confirm view. `*` is rejected.
 *
 * Agent scope: title "Rules for <agent name>". `*` is pinned first as
 * "All sites", the rest sorted by domain. `+ Add rule` allows `*` (with a
 * hint that it sets the agent's default). Delete uses the same in-place
 * confirm view with agent-specific copy.
 *
 * Esc from a sub-view returns to the list rather than closing the modal.
 * Focus moves into each new view (first field, or Cancel in the confirm
 * view) and back to the control that triggered the switch on return.
 *
 * Props:
 *   open, onClose
 *   scope                — 'global' | 'agent'
 *   globalRules          — (global) [{domain, decision, source, createdAt, updatedAt}]
 *   globalSiteBlocklist  — (global) {enabled, version, lastFetchedAt, domainCount} | null
 *   agentName            — (agent) display name for the title
 *   rules                — (agent) [{domain, decision, createdAt}]
 *   rulesLoading, rulesError, onRetry — (agent) load state for `rules`
 *   busy                 — a write for this scope is in flight
 *   onAddRule({domain, decision}) → Promise<boolean>
 *   onDeleteRule(domain)          → Promise<boolean>
 */
export default function RulesModal({
  open,
  onClose,
  scope,
  globalRules,
  globalSiteBlocklist,
  agentName,
  rules,
  rulesLoading = false,
  rulesError = null,
  onRetry,
  busy = false,
  onAddRule,
  onDeleteRule,
}) {
  const reactId = useId();
  const titleId = `wp-rules-modal-title-${reactId}`;
  const isGlobal = scope === 'global';

  const [view, setView] = useState('list');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [confirmDomain, setConfirmDomain] = useState(null);

  const searchRef = useRef(null);
  const cancelRef = useRef(null);
  const addBtnRef = useRef(null);
  const deleteBtnRefs = useRef(new Map());
  const returnFocusDomainRef = useRef(null);
  const prevViewRef = useRef('list');

  // Reset on open.
  useEffect(() => {
    if (open) {
      setView('list');
      setQuery('');
      setPage(0);
      setConfirmDomain(null);
      prevViewRef.current = 'list';
    }
  }, [open]);

  // Focus management across view switches. Modal's initialFocusRef only
  // fires on open, so the confirm view and the return-to-list transition are
  // handled here. The add view focuses its own first field via autoFocus.
  useEffect(() => {
    if (!open) return;
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    if (view === prev) return;
    if (view === 'confirmDelete') {
      setTimeout(() => { try { cancelRef.current && cancelRef.current.focus(); } catch (_) { /* ignore */ } }, 0);
    } else if (view === 'list') {
      const d = returnFocusDomainRef.current;
      const btn = d ? deleteBtnRefs.current.get(d) : null;
      setTimeout(() => {
        try {
          if (btn && btn.isConnected) btn.focus();
          else if (prev === 'add' && addBtnRef.current) addBtnRef.current.focus();
          else if (isGlobal && searchRef.current) searchRef.current.focus();
          else if (addBtnRef.current) addBtnRef.current.focus();
        } catch (_) { /* ignore */ }
      }, 0);
      returnFocusDomainRef.current = null;
    }
  }, [view, open, isGlobal]);

  const globalList = Array.isArray(globalRules) ? globalRules : [];
  const agentList = Array.isArray(rules) ? rules : [];

  // Grouping is memoized: the signed list can hold thousands of rows.
  const groups = useMemo(() => {
    if (!isGlobal) return null;
    const userAllow = [];
    const userBlock = [];
    const signed = [];
    for (const r of globalList) {
      if (r.source === 'user') {
        if (r.decision === 'allow') userAllow.push(r);
        else userBlock.push(r);
      } else if (r.source === 'global_site_blocklist') {
        signed.push(r);
      }
    }
    userAllow.sort(byDomain);
    userBlock.sort(byDomain);
    signed.sort(byDomain);
    const allowSet = new Set(userAllow.map((r) => r.domain));
    return { userAllow, userBlock, signed, allowSet };
  }, [isGlobal, globalList]);

  const flat = useMemo(() => {
    if (isGlobal) {
      const q = query.trim().toLowerCase();
      const match = (r) => !q || r.domain.toLowerCase().includes(q);
      const out = [];
      for (const key of ['userAllow', 'userBlock', 'signed']) {
        for (const r of groups[key]) {
          if (match(r)) out.push({ group: key, rule: r });
        }
      }
      return out;
    }
    const list = [...agentList];
    list.sort((a, b) => {
      if (a.domain === '*') return -1;
      if (b.domain === '*') return 1;
      return a.domain.localeCompare(b.domain);
    });
    return list.map((rule) => ({ group: 'agent', rule }));
  }, [isGlobal, groups, agentList, query]);

  const groupCounts = useMemo(() => {
    if (!isGlobal) return null;
    const counts = { userAllow: 0, userBlock: 0, signed: 0 };
    for (const item of flat) counts[item.group] += 1;
    return counts;
  }, [isGlobal, flat]);

  const totalPages = isGlobal ? Math.max(1, Math.ceil(flat.length / PAGE_SIZE)) : 1;
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = isGlobal ? flat.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE) : flat;

  useEffect(() => {
    if (isGlobal && page > totalPages - 1) setPage(totalPages - 1);
  }, [isGlobal, page, totalPages]);

  const domainCount = (globalSiteBlocklist && globalSiteBlocklist.domainCount) || (groups ? groups.signed.length : 0);
  const userCount = groups ? groups.userAllow.length + groups.userBlock.length : 0;

  // Esc in a sub-view returns to the list rather than closing the modal.
  function handleModalClose() {
    if (view !== 'list') {
      setView('list');
      return;
    }
    onClose();
  }

  function openAdd() {
    setView('add');
  }

  function backToList() {
    setView('list');
  }

  function openConfirmDelete(domain) {
    returnFocusDomainRef.current = domain;
    setConfirmDomain(domain);
    setView('confirmDelete');
  }

  async function handleConfirmDelete() {
    const domain = confirmDomain;
    const ok = await onDeleteRule(domain);
    if (ok) returnFocusDomainRef.current = null;
    setConfirmDomain(null);
    setView('list');
  }

  async function handleAdd(values) {
    const ok = await onAddRule(values);
    if (ok) setView('list');
    return ok;
  }

  const title = isGlobal ? 'Global block list' : `Rules for ${agentName || 'this agent'}`;

  const countLine = isGlobal ? (
    <div className="wp-site-policy-facts">
      {domainCount} signed domains · {userCount} custom {userCount === 1 ? 'rule' : 'rules'}
      {globalSiteBlocklist && globalSiteBlocklist.version ? ` · version ${globalSiteBlocklist.version}` : ''}
    </div>
  ) : null;

  const confirmTitle = confirmDomain
    ? (isGlobal
      ? `Remove global rule for ${confirmDomain}?`
      : `Remove rule for ${confirmDomain === '*' ? 'all sites (*)' : confirmDomain}?`)
    : '';
  const confirmBody = isGlobal
    ? 'Agents fall back to the signed list and defaults for this site. You can add it again here.'
    : `${agentName || 'This agent'} falls back to global rules and defaults for this site.`;

  let body;
  if (view === 'confirmDelete') {
    body = (
      <div className="wp-modal-body">{confirmBody}</div>
    );
  } else if (view === 'add') {
    body = (
      <AddRuleForm
        allowWildcard={!isGlobal}
        hint={!isGlobal ? "Use * to set this agent's default for every site." : null}
        onSubmit={handleAdd}
        onCancel={backToList}
        busy={busy}
        defaultDecision={isGlobal ? 'block' : 'allow'}
        submitLabel={isGlobal ? 'Add global rule' : 'Add rule'}
      />
    );
  } else if (!isGlobal && rulesError) {
    body = <EmptyState variant="bare" body="Couldn’t load rules for this agent." action={onRetry ? (
      <button type="button" className="wp-btn" onClick={onRetry}>Retry</button>
    ) : null} />;
  } else if (!isGlobal && rulesLoading && agentList.length === 0) {
    body = <EmptyState variant="bare" body="Loading rules…" />;
  } else if (pageItems.length === 0) {
    body = (
      <EmptyState
        variant="bare"
        body={isGlobal
          ? (query.trim() ? `No domains match "${query.trim()}".` : 'No global rules yet.')
          : 'No rules for this agent. Global rules and defaults apply.'}
      />
    );
  } else {
    let lastGroup = null;
    body = pageItems.map(({ group, rule }) => {
      const header = isGlobal && group !== lastGroup ? (
        <div className="wp-rules-modal-group" role="heading" aria-level={3}>
          {GROUP_LABELS[group]} ({groupCounts[group]})
        </div>
      ) : null;
      lastGroup = group;
      const isSignedRow = isGlobal && group === 'signed';
      const overridden = isSignedRow && groups.allowSet.has(rule.domain);
      const isAll = !isGlobal && rule.domain === '*';
      return (
        <div key={`${group}:${rule.domain}`}>
          {header}
          <div className="wp-row">
            <div className="wp-row-grow">
              <div className="wp-row-title">
                {isAll ? (
                  <>All sites <span className="wp-mono wp-secondary">*</span></>
                ) : (
                  <span className="wp-site-policy-rule-domain">{rule.domain}</span>
                )}
              </div>
              {!isSignedRow && (rule.updatedAt || rule.createdAt) ? (
                <div className="wp-row-sub">
                  <DecisionPill decision={rule.decision} />
                  <span className="wp-row-sep">·</span>
                  <span>{isGlobal ? 'updated' : 'added'} {relTime(rule.updatedAt || rule.createdAt)}</span>
                </div>
              ) : !isSignedRow ? (
                <div className="wp-row-sub"><DecisionPill decision={rule.decision} /></div>
              ) : null}
              {overridden ? (
                <div className="wp-row-sub">Overridden by your allow</div>
              ) : null}
            </div>
            {!isSignedRow ? (
              <div className="wp-row-actions">
                <button
                  ref={(el) => {
                    if (el) deleteBtnRefs.current.set(rule.domain, el);
                    else deleteBtnRefs.current.delete(rule.domain);
                  }}
                  type="button"
                  className="wp-btn wp-btn-compact"
                  onClick={() => openConfirmDelete(rule.domain)}
                  disabled={busy}
                  aria-label={`Delete rule for ${isAll ? 'all sites' : rule.domain}`}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
      );
    });
  }

  let footer;
  if (view === 'confirmDelete') {
    footer = (
      <>
        <button ref={cancelRef} type="button" className="wp-btn" onClick={backToList}>
          Cancel
        </button>
        <button
          type="button"
          className="wp-btn wp-btn-danger"
          onClick={handleConfirmDelete}
          disabled={busy}
        >
          {busy ? 'Removing…' : 'Delete'}
        </button>
      </>
    );
  } else if (view === 'add') {
    footer = null; // AddRuleForm renders its own actions row.
  } else {
    footer = (
      <>
        <button
          ref={addBtnRef}
          type="button"
          className="wp-btn"
          onClick={openAdd}
          disabled={busy}
        >
          {isGlobal ? '+ Add global rule' : '+ Add rule'}
        </button>
        {isGlobal ? (
          <div className="wp-rules-modal-pager">
            <span className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>
              {flat.length} {flat.length === 1 ? 'result' : 'results'}
            </span>
            <button
              type="button"
              className="wp-link"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            >
              ← Prev
            </button>
            <span className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>
              Page {safePage + 1} of {totalPages}
            </span>
            <button
              type="button"
              className="wp-link"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
            >
              Next →
            </button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleModalClose}
      titleId={titleId}
      size="lg"
      initialFocusRef={isGlobal ? searchRef : null}
    >
      <div className="wp-rules-modal">
        <div className="wp-rules-modal-header">
          <div className="wp-site-policy-card-head">
            <div>
              <h2 id={titleId} className="wp-modal-title">
                {view === 'confirmDelete' ? confirmTitle : title}
              </h2>
              {view === 'list' ? countLine : null}
            </div>
            <button
              type="button"
              className="wp-btn wp-btn-compact"
              onClick={onClose}
              aria-label="Close"
              title="Close"
            >
              ×
            </button>
          </div>
          {isGlobal && view === 'list' ? (
            <input
              ref={searchRef}
              className="wp-input"
              type="search"
              autoComplete="off"
              aria-label="Search domains"
              placeholder="Search domains…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            />
          ) : null}
        </div>

        <div className="wp-rules-modal-body">{body}</div>

        {footer ? <div className="wp-rules-modal-footer">{footer}</div> : null}
      </div>
    </Modal>
  );
}
