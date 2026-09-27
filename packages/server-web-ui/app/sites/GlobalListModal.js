'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal';
import Pill from '../../components/Pill';
import EmptyState from '../../components/EmptyState';
import { formatRelativeTime } from '../../lib/format';

/**
 * Shared helpers for the Sites page. Exported here (rather than a separate
 * module) so the AgentRulesPanel can reuse the add-rule form and pill.
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
    ? <Pill state="ready" label="Allow" />
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
  const domainId = `wp-sites-domain-${reactId}`;
  const hintId = `wp-sites-domain-hint-${reactId}`;
  const errorId = `wp-sites-domain-error-${reactId}`;
  const radioName = `wp-sites-decision-${reactId}`;
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
    <form className="wp-sites-form" onSubmit={handleSubmit}>
      <div className="wp-sites-field">
        <label htmlFor={domainId} className="wp-sites-field-label">Domain</label>
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
          <span id={errorId} className="wp-sites-field-error">{wildcardError}</span>
        ) : null}
        {hint ? <span id={hintId} className="wp-sites-field-hint">{hint}</span> : null}
        {!wildcardError && showPreview ? (
          <span className="wp-sites-field-hint">
            Will be saved as <span className="wp-mono">{normalized}</span>.
          </span>
        ) : null}
      </div>
      <div className="wp-sites-radios" role="radiogroup" aria-label="Decision">
        <label className="wp-sites-radio">
          <input
            type="radio"
            name={radioName}
            value="allow"
            checked={decision === 'allow'}
            onChange={() => setDecision('allow')}
          />
          <span>Allow</span>
        </label>
        <label className="wp-sites-radio">
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
      <div className="wp-sites-actions" style={{ justifyContent: 'flex-end' }}>
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
 * GlobalListModal — searchable, paginated view of every global rule.
 *
 * Groups (in order): your allows, your blocks, the signed block list. User
 * rows can be deleted through an in-place confirm view (the same Modal
 * switches content; no nested modal so Esc / focus trap stay single). Signed
 * rows are read-only. "+ Add global rule" reveals an inline form; wildcards
 * are rejected client-side because they are per-agent only.
 *
 * Props:
 *   open, onClose
 *   globalRules          — [{domain, decision, source, createdAt, updatedAt}]
 *   globalSiteBlocklist  — {enabled, version, lastFetchedAt, domainCount} | null
 *   busy                 — a global write is in flight
 *   onAddRule({domain, decision}) → Promise<boolean>
 *   onDeleteRule(domain)          → Promise<boolean>
 */
export default function GlobalListModal({
  open,
  onClose,
  globalRules,
  globalSiteBlocklist,
  busy = false,
  onAddRule,
  onDeleteRule,
}) {
  const reactId = useId();
  const titleId = `wp-global-list-title-${reactId}`;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  // Domain awaiting delete confirmation; non-null switches to the confirm view.
  const [confirmDomain, setConfirmDomain] = useState(null);
  const searchRef = useRef(null);
  const cancelRef = useRef(null);
  const addBtnRef = useRef(null);
  const deleteBtnRefs = useRef(new Map());
  // Where focus goes when returning from the confirm view: a domain whose
  // Delete button should regain focus, or null for the search box.
  const returnFocusDomainRef = useRef(null);
  const prevConfirmRef = useRef(null);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setPage(0);
      setAddOpen(false);
      setConfirmDomain(null);
    }
  }, [open]);

  // Focus management across view switches. Modal's initialFocusRef only
  // fires on open, so do it here.
  useEffect(() => {
    const prev = prevConfirmRef.current;
    prevConfirmRef.current = confirmDomain;
    if (!open) return;
    if (confirmDomain && !prev) {
      try { cancelRef.current && cancelRef.current.focus(); } catch (_) { /* ignore */ }
    } else if (!confirmDomain && prev) {
      const d = returnFocusDomainRef.current;
      const btn = d ? deleteBtnRefs.current.get(d) : null;
      try {
        if (btn && btn.isConnected) btn.focus();
        else if (searchRef.current) searchRef.current.focus();
      } catch (_) { /* ignore */ }
      returnFocusDomainRef.current = null;
    }
  }, [confirmDomain, open]);

  const rules = Array.isArray(globalRules) ? globalRules : [];

  // Grouping is memoized: the signed list can hold thousands of rows.
  const groups = useMemo(() => {
    const userAllow = [];
    const userBlock = [];
    const signed = [];
    for (const r of rules) {
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
  }, [rules]);

  const flat = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r) => !q || r.domain.toLowerCase().includes(q);
    const out = [];
    for (const key of ['userAllow', 'userBlock', 'signed']) {
      for (const r of groups[key]) {
        if (match(r)) out.push({ group: key, rule: r });
      }
    }
    return out;
  }, [groups, query]);

  const groupCounts = useMemo(() => {
    const counts = { userAllow: 0, userBlock: 0, signed: 0 };
    for (const item of flat) counts[item.group] += 1;
    return counts;
  }, [flat]);

  const totalPages = Math.max(1, Math.ceil(flat.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = flat.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);

  const domainCount = (globalSiteBlocklist && globalSiteBlocklist.domainCount) || groups.signed.length;
  const userCount = groups.userAllow.length + groups.userBlock.length;

  // Esc in the confirm view returns to the list rather than closing.
  function handleModalClose() {
    if (confirmDomain) {
      setConfirmDomain(null);
      return;
    }
    onClose();
  }

  async function handleConfirmDelete() {
    const domain = confirmDomain;
    const ok = await onDeleteRule(domain);
    if (ok) {
      // Row is gone; focus falls back to search.
      returnFocusDomainRef.current = null;
    }
    setConfirmDomain(null);
  }

  async function handleAdd(values) {
    const ok = await onAddRule(values);
    if (ok) {
      setAddOpen(false);
      setTimeout(() => { try { addBtnRef.current && addBtnRef.current.focus(); } catch (_) { /* ignore */ } }, 0);
    }
    return ok;
  }

  const countLine = (
    <div className="wp-sites-facts" style={{ marginTop: 'var(--s-1)' }}>
      {domainCount} signed domains · {userCount} custom {userCount === 1 ? 'rule' : 'rules'}
      {globalSiteBlocklist && globalSiteBlocklist.version ? ` · version ${globalSiteBlocklist.version}` : ''}
    </div>
  );

  const confirmView = confirmDomain ? (
    <div className="wp-global-list">
      <h2 id={titleId} className="wp-modal-title">Remove global rule for {confirmDomain}?</h2>
      <div className="wp-modal-body">
        Agents fall back to the signed list and defaults for this site. You can add it again here.
      </div>
      <div className="wp-modal-actions">
        <button
          ref={cancelRef}
          type="button"
          className="wp-btn"
          onClick={() => setConfirmDomain(null)}
        >
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
      </div>
    </div>
  ) : null;

  let lastGroup = null;

  return (
    <Modal
      open={open}
      onClose={handleModalClose}
      titleId={titleId}
      size="lg"
      initialFocusRef={searchRef}
    >
      {confirmView || (
      <div className="wp-global-list">
        <div className="wp-sites-card-head">
          <div>
            <h2 id={titleId} className="wp-modal-title">Global block list</h2>
            {countLine}
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

        {addOpen ? (
          <AddRuleForm
            allowWildcard={false}
            onSubmit={handleAdd}
            onCancel={() => {
              setAddOpen(false);
              setTimeout(() => { try { addBtnRef.current && addBtnRef.current.focus(); } catch (_) { /* ignore */ } }, 0);
            }}
            busy={busy}
            defaultDecision="block"
            submitLabel="Add global rule"
          />
        ) : (
          <div className="wp-sites-actions">
            <button
              ref={addBtnRef}
              type="button"
              className="wp-btn"
              onClick={() => setAddOpen(true)}
              disabled={busy}
            >
              + Add global rule
            </button>
          </div>
        )}

        <div className="wp-global-list-rows">
          {flat.length === 0 ? (
            <EmptyState
              variant="bare"
              body={query.trim() ? `No domains match "${query.trim()}".` : 'No global rules yet.'}
            />
          ) : (
            pageItems.map(({ group, rule }) => {
              const header = group !== lastGroup ? (
                <div className="wp-global-list-group" role="heading" aria-level={3}>
                  {GROUP_LABELS[group]} ({groupCounts[group]})
                </div>
              ) : null;
              lastGroup = group;
              const isUser = group !== 'signed';
              const overridden = !isUser && groups.allowSet.has(rule.domain);
              return (
                <div key={`${group}:${rule.domain}`}>
                  {header}
                  <div className="wp-row">
                    <div className="wp-row-grow">
                      <div className="wp-sites-rule-domain">{rule.domain}</div>
                      {isUser && (rule.updatedAt || rule.createdAt) ? (
                        <div className="wp-row-sub">updated {relTime(rule.updatedAt || rule.createdAt)}</div>
                      ) : null}
                      {overridden ? (
                        <div className="wp-row-sub">Overridden by your allow</div>
                      ) : null}
                    </div>
                    {isUser ? (
                      <div className="wp-row-actions">
                        <DecisionPill decision={rule.decision} />
                        <button
                          ref={(el) => {
                            if (el) deleteBtnRefs.current.set(rule.domain, el);
                            else deleteBtnRefs.current.delete(rule.domain);
                          }}
                          type="button"
                          className="wp-btn wp-btn-compact"
                          onClick={() => {
                            returnFocusDomainRef.current = rule.domain;
                            setConfirmDomain(rule.domain);
                          }}
                          disabled={busy}
                          aria-label={`Delete global rule for ${rule.domain}`}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="wp-global-list-pager">
          <span className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>
            {flat.length} {flat.length === 1 ? 'result' : 'results'}
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-3)' }}>
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
        </div>
      </div>
      )}
    </Modal>
  );
}
