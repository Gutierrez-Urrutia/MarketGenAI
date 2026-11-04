/**
 * LeadContactsPanel — contact search of one lead (Agente 2, RF15).
 *
 * Shown in the lead's expanded row of LeadList. One search at a time on the
 * whole screen (each one may spend Hunter credits): the lock lives in
 * LeadList and is passed in as `searchLock`. The button is never disabled
 * for a missing Hunter key — reusing contacts needs none; the backend answers
 * 422 hunter_not_configured when a key is really needed. The result of the
 * last search is read from lead.contacts_search, never from lead.status.
 *
 * Contacts are personal data: nothing here logs them (the API calls are
 * marked logBody: false).
 */
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Loader2, Users, CheckCircle2, AlertTriangle, HelpCircle, Copy, Check, X, RotateCcw, Settings, RefreshCw,
} from "lucide-react";

import { leadsApi } from "@/api/axios";
import { useI18n } from "@/hooks/useI18n";
import { formatDateTime } from "@/utils/dates";
import {
  canSearchLead, confidenceOf, describeSearchError, describeSearchResult, lastSearchOf, roleKey, verificationOf,
} from "./contactLabels";

const K = "leads.contacts";

const TONE_CLASSES = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  info: "border-gray-200 bg-gray-50 text-gray-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-700",
};

const fill = (text, params = {}) => Object.entries(params).reduce(
  (out, [name, value]) => out.split(`{${name}}`).join(String(value)),
  text,
);

const SmallBtn = ({ children, variant = "secondary", className = "", ...props }) => {
  const variants = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700",
    secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50",
    danger: "bg-white text-red-700 border border-red-200 hover:bg-red-50",
    success: "bg-white text-emerald-700 border border-emerald-200 hover:bg-emerald-50",
  };
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-disabled:opacity-60 aria-disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

function Verification({ contact, t }) {
  const kind = verificationOf(contact.email_verification_status);
  if (kind === "verified") {
    const label = contact.email_verified_at
      ? fill(t(`${K}.verification.verifiedOn`), { date: formatDateTime(contact.email_verified_at) })
      : t(`${K}.verification.verified`);
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <CheckCircle2 size={12} aria-hidden="true" />{label}
      </span>
    );
  }
  if (kind === "risky") {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700" title={t(`${K}.verification.riskyHint`)}>
        <AlertTriangle size={12} aria-hidden="true" />{t(`${K}.verification.risky`)}
        <span className="sr-only">: {t(`${K}.verification.riskyHint`)}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-gray-500">
      <HelpCircle size={12} aria-hidden="true" />{t(`${K}.verification.unverified`)}
    </span>
  );
}

function ContactCard({ contact, t, busy, onReview }) {
  const confidence = confidenceOf(contact.confidence_score);
  const status = contact.review_status || "not_required";
  const name = contact.full_name;
  const reviewLabel = (key) => `${t(`${K}.review.${key}`)}: ${name}`;
  return (
    <li className="min-w-0 rounded-xl border border-gray-200 bg-white p-3 text-xs space-y-1.5 break-words">
      <div className="flex flex-wrap items-start justify-between gap-1.5">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 text-sm">{name}</p>
          {contact.job_title && <p className="text-gray-600">{contact.job_title}</p>}
        </div>
        <span className="shrink-0 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-medium">
          {t(roleKey(contact.role))}
        </span>
      </div>
      <p className="text-gray-800 break-all select-all">
        {contact.email || <span className="italic text-gray-400">{t(`${K}.list.noEmail`)}</span>}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <Verification contact={contact} t={t} />
        <span className="text-gray-600">{fill(t(`${K}.confidence.${confidence.level}`), { pct: confidence.percent })}</span>
      </div>
      {contact.reused_from_lead_id && (
        <p className="inline-flex items-center gap-1 text-gray-500">
          <Copy size={12} aria-hidden="true" />{t(`${K}.list.copied`)}
        </p>
      )}
      {status !== "not_required" && (
        <p>
          <span className={`inline-block px-2 py-0.5 rounded-full font-medium ${
            status === "pending" ? "bg-amber-100 text-amber-800"
              : status === "approved" ? "bg-emerald-100 text-emerald-800"
                : "bg-gray-200 text-gray-700"}`}
          >
            {t(`${K}.review.${status}`)}
          </span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {status === "pending" && (
          <SmallBtn variant="success" disabled={busy} aria-label={reviewLabel("approve")} onClick={() => onReview(contact, "approved")}>
            <Check size={12} aria-hidden="true" />{t(`${K}.review.approve`)}
          </SmallBtn>
        )}
        {status !== "rejected" && (
          <SmallBtn variant="danger" disabled={busy} aria-label={reviewLabel("reject")} onClick={() => onReview(contact, "rejected")}>
            <X size={12} aria-hidden="true" />{t(`${K}.review.reject`)}
          </SmallBtn>
        )}
        {status === "rejected" && (
          <SmallBtn disabled={busy} aria-label={reviewLabel("restore")} onClick={() => onReview(contact, "approved")}>
            <RotateCcw size={12} aria-hidden="true" />{t(`${K}.review.restore`)}
          </SmallBtn>
        )}
      </div>
    </li>
  );
}

export default function LeadContactsPanel({ lead, searchLock, onLeadChanged, onNavigate }) {
  const { t } = useI18n();
  const leadId = lead.id;
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [message, setMessage] = useState(null);
  const [reviewing, setReviewing] = useState(() => new Set());
  const reviewingRef = useRef(new Set());
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const statusId = `lead-contacts-status-${leadId}`;
  const reasonId = `lead-contacts-reason-${leadId}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadContacts = async (includeRejected = showRejected) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const { data } = await leadsApi.listContacts(leadId, { includeRejected });
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setContacts(data?.items || []);
    } catch {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setLoadError(true);
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadContacts(showRejected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, showRejected]);

  const searchable = canSearchLead(lead);
  const searchingHere = searchLock.activeLeadId === leadId;
  const blockedByOther = Boolean(searchLock.activeLeadId) && !searchingHere;
  const blocked = !searchable || searchLock.activeLeadId !== null;

  const search = async (force = false) => {
    if (!searchable) return;
    if (!searchLock.tryAcquire(leadId)) return; // one search at a time, checked before any await
    setMessage(null);
    try {
      const { data } = await leadsApi.searchContacts(leadId, { force: force === true });
      if (!mountedRef.current) return;
      setMessage(describeSearchResult(data));
      if (showRejected) await loadContacts(true);
      else setContacts(data?.contacts || []);
      onLeadChanged?.(leadId, {
        status: data?.lead_status,
        contacts_search: {
          ...(lead.contacts_search || {}),
          state: data?.state,
          reason: data?.reason ?? null,
          search_id: data?.search_id,
          searched_at: data?.searched_at,
          reused_from_lead_id: data?.reused_from_lead_id ?? null,
        },
      });
    } catch (error) {
      if (!mountedRef.current) return;
      const described = describeSearchError(error);
      setMessage(described);
      if (described.action === "reload") {
        loadContacts();
        onLeadChanged?.(leadId, null);
      }
    } finally {
      searchLock.release(leadId);
    }
  };

  const refresh = () => {
    setMessage(null);
    loadContacts();
    onLeadChanged?.(leadId, null);
  };

  const review = async (contact, decision) => {
    if (reviewingRef.current.has(contact.id)) return;
    reviewingRef.current.add(contact.id);
    setReviewing(new Set(reviewingRef.current));
    try {
      const { data } = await leadsApi.reviewContact(leadId, contact.id, decision);
      if (!mountedRef.current) return;
      // The backend recomputes the lead's status after a review (lead_status).
      const { lead_status: leadStatus, ...updated } = data || {};
      setContacts((list) => (decision === "rejected" && !showRejected
        ? list.filter((item) => item.id !== contact.id)
        : list.map((item) => (item.id === contact.id ? { ...item, ...updated } : item))));
      onLeadChanged?.(leadId, leadStatus ? { status: leadStatus } : null);
    } catch (error) {
      if (!mountedRef.current) return;
      const status = error?.response?.status;
      if (status === 422 || status === 404) {
        toast.error(t(`${K}.review.invalidTransition`));
        loadContacts();
      } else {
        toast.error(t(`${K}.review.error`));
      }
    } finally {
      reviewingRef.current.delete(contact.id);
      if (mountedRef.current) setReviewing(new Set(reviewingRef.current));
    }
  };

  const last = lastSearchOf(lead);
  const renderMessage = () => {
    if (!message) return null;
    const params = { ...(message.params || {}) };
    if (params.date) params.date = formatDateTime(params.date);
    return (
      <div
        role={message.tone === "error" ? "alert" : undefined}
        data-tone={message.tone}
        className={`rounded-xl border px-3 py-2 text-xs space-y-1.5 ${TONE_CLASSES[message.tone] || TONE_CLASSES.info}`}
      >
        <p>{fill(t(message.key), params)}</p>
        {message.reused && <p>{t(`${K}.result.reused`)}</p>}
        {message.credits && (
          <p>
            {fill(t(`${K}.result.creditsUsed`), { used: message.credits.used })}
            {message.credits.remaining !== null && ` ${fill(t(`${K}.result.creditsRemaining`), { remaining: message.credits.remaining })}`}
          </p>
        )}
        {(message.action === "forceCooldown" || message.action === "forceArea") && (
          <div className="space-y-1">
            <p id={`${statusId}-force-hint`}>
              {t(message.action === "forceCooldown" ? `${K}.action.forceCooldownHint` : `${K}.action.forceAreaHint`)}
            </p>
            <SmallBtn
              variant="primary"
              aria-disabled={blocked || undefined}
              aria-describedby={`${statusId}-force-hint`}
              onClick={() => { if (!blocked) search(true); }}
            >
              {t(message.action === "forceCooldown" ? `${K}.action.forceCooldown` : `${K}.action.forceArea`)}
            </SmallBtn>
          </div>
        )}
        {message.action === "settings" && (
          <SmallBtn onClick={() => onNavigate?.("settings", { tab: "pipeline" })}>
            <Settings size={12} aria-hidden="true" />{t(`${K}.action.goToSettings`)}
          </SmallBtn>
        )}
        {message.action === "retry" && (
          <SmallBtn aria-disabled={blocked || undefined} onClick={() => { if (!blocked) search(false); }}>
            <RefreshCw size={12} aria-hidden="true" />{t(`${K}.action.retry`)}
          </SmallBtn>
        )}
        {message.action === "refresh" && (
          <SmallBtn onClick={refresh}>
            <RefreshCw size={12} aria-hidden="true" />{t(`${K}.action.refresh`)}
          </SmallBtn>
        )}
      </div>
    );
  };

  const reason = !searchable
    ? fill(t(`${K}.notSearchable`), { status: t(`leads.status.${lead.status}`) })
    : blockedByOther ? t(`${K}.blockedByOther`) : null;

  return (
    <section
      aria-label={t(`${K}.panelTitle`)}
      className="space-y-3 p-3 sm:p-4 bg-indigo-50/30 border-t border-indigo-100"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SmallBtn
          variant="primary"
          aria-disabled={blocked || undefined}
          aria-busy={searchingHere || undefined}
          aria-describedby={reason ? reasonId : undefined}
          onClick={() => { if (!blocked) search(false); }}
        >
          {searchingHere ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Users size={12} aria-hidden="true" />}
          {searchingHere ? t(`${K}.searching`) : t(`${K}.search`)}
        </SmallBtn>
        {reason && <p id={reasonId} className="text-xs text-gray-500">{reason}</p>}
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={showRejected}
            onChange={(event) => setShowRejected(event.target.checked)}
            className="rounded border-gray-300"
          />
          {t(`${K}.list.showRejected`)}
        </label>
      </div>

      <div id={statusId} aria-live="polite" className="space-y-2">
        {searchingHere && <p className="text-xs text-gray-600">{t(`${K}.searchingHint`)}</p>}
        {renderMessage()}
        {!message && !searchingHere && last && (
          <p className={`text-xs ${last.isError ? "text-red-700" : "text-gray-500"}`}>
            {fill(t(last.when ? `${K}.lastSearch` : `${K}.lastSearchNoDate`), {
              date: formatDateTime(last.when),
              result: t(last.stateKey),
            })}
            {last.detailKey && ` — ${t(last.detailKey)}`}
          </p>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-gray-400">{t(`${K}.list.loading`)}</p>
      ) : loadError ? (
        <div className="text-xs space-x-2">
          <span className="text-red-600">{t(`${K}.list.loadError`)}</span>
          <SmallBtn onClick={() => loadContacts()}>{t(`${K}.action.retry`)}</SmallBtn>
        </div>
      ) : contacts.length === 0 ? (
        <p className="text-xs text-gray-400">{t(`${K}.list.empty`)}</p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {contacts.map((contact) => (
            <ContactCard key={contact.id} contact={contact} t={t} busy={reviewing.has(contact.id)} onReview={review} />
          ))}
        </ul>
      )}
    </section>
  );
}
