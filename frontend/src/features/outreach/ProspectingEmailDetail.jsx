/**
 * ProspectingEmailDetail — one prospecting email (RF-VTA-16) in «Alcance».
 *
 * Subject and body are model output: they are rendered as plain text only
 * (text nodes inside <pre>), never as HTML. The actions depend on the status:
 * pending_review → regenerate (optionally in another language), reject,
 * approve; approved → copy, send (real SMTP), mark as sent, reject; sent /
 * rejected → none. «Copiar» never calls the API nor changes the email.
 *
 * Real send: «Enviar» is disabled, with a short note saying why, unless the
 * SMTP account is complete, both real-send switches are on, the contact is
 * reviewed, the recipient is not on the do-not-contact list and today's quota
 * is not used up (sendBlockReason). It always asks for confirmation showing
 * the recipient and the sender. After a send of unknown outcome (timeout
 * during DATA) it becomes «Reintentar envío», behind a second, stronger
 * confirmation; only that one sends `forceRetry`. The opt-out line the server
 * appends when sending is shown apart from the body, so the reviewer sees
 * exactly what goes out.
 */
import { useEffect, useId, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DEFAULT_EMAIL_LANGUAGE, EMAIL_LANGUAGES, isUncertain, languageLabel, sendBlockReason } from "./prospectingEmails";
import { formatDateTime } from "@/utils/dates";

const KP = "outreachPage.prospecting";

const fill = (text, params = {}) => Object.entries(params).reduce(
  (out, [name, value]) => out.split(`{${name}}`).join(String(value)),
  text,
);

const STATUS_CLASSES = {
  pending_review: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  sent: "bg-indigo-100 text-indigo-800",
  rejected: "bg-gray-200 text-gray-700",
};

const Action = ({ children, variant = "secondary", ...props }) => {
  const variants = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700",
    secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50",
    danger: "bg-white text-red-700 border border-red-200 hover:bg-red-50",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
  };
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-60 disabled:cursor-not-allowed ${variants[variant]}`}
      {...props}
    >
      {children}
    </button>
  );
};

export function EmailStatusBadge({ status, t }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASSES[status] || STATUS_CLASSES.rejected}`}>
      {t(`${KP}.status.${status}`)}
    </span>
  );
}

const errorText = (t, code) => t(`${KP}.errors.${code}`);

function History({ email, t }) {
  const entries = email.history || [];
  if (!entries.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-gray-700">{t(`${KP}.history.title`)}</p>
      <ol className="space-y-1 text-xs text-gray-600">
        {entries.map((entry, index) => (
          <li key={`${entry.action}-${index}`} className="space-y-0.5">
            <span className="font-medium text-gray-800">{t(`${KP}.history.actions.${entry.action}`)}</span>
            {entry.by_name && <span> · {fill(t(`${KP}.history.by`), { name: entry.by_name })}</span>}
            {entry.at && <span> · {formatDateTime(entry.at)}</span>}
            {entry.previous_language && <span> · {languageLabel(entry.previous_language)}</span>}
            {entry.send_error && <span> · {fill(t(`${KP}.history.sendError`), { error: errorText(t, entry.send_error) })}</span>}
            {(entry.previous_subject || entry.previous_body) && (
              <details className="ml-2">
                <summary className="cursor-pointer text-indigo-600">{t(`${KP}.history.previousVersion`)}</summary>
                <p className="font-medium text-gray-800 whitespace-pre-wrap">{entry.previous_subject}</p>
                <pre className="whitespace-pre-wrap font-sans text-gray-600">{entry.previous_body}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// The send confirmation's To / From / Subject: one row each, a small grey
// label above its value. Long addresses wrap at any point instead of
// overflowing; the sender's name and address go on separate lines.
function SummaryRow({ label, testId, children }) {
  return (
    <div data-testid={testId}>
      <dt className="text-xs text-gray-500 dark:text-slate-400">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-white [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function SendSummary({ email, sendStatus, t }) {
  const senderName = sendStatus?.sender_name || "";
  const senderEmail = sendStatus?.sender_email || "";
  return (
    <dl className="space-y-2" data-testid="send-summary">
      <SummaryRow label={t(`${KP}.send.toLabel`)} testId="send-summary-to">{email.to_email || "—"}</SummaryRow>
      <SummaryRow label={t(`${KP}.send.fromLabel`)} testId="send-summary-from">
        {senderName && <span className="block" data-testid="send-summary-from-name">{senderName}</span>}
        <span className="block text-gray-600 dark:text-slate-300" data-testid="send-summary-from-email">{senderEmail || "—"}</span>
      </SummaryRow>
      <SummaryRow label={t(`${KP}.send.subjectLabel`)} testId="send-summary-subject">{email.subject || "—"}</SummaryRow>
    </dl>
  );
}

function BlockNote({ id, reason, sendStatus, t, onOpenSettings }) {
  const fields = (sendStatus?.smtp_missing_fields || []).map((field) => t(`${KP}.send.fields.${field}`)).join(", ");
  return (
    <p id={id} role="note" className="text-right text-xs text-gray-500" data-testid="send-block-note">
      {fill(t(`${KP}.send.blocked.${reason}`), { fields })}
      {["smtp_not_configured", "user_disabled"].includes(reason) && onOpenSettings && (
        <>
          {" "}
          <button type="button" className="font-medium text-indigo-600 underline" onClick={() => onOpenSettings()}>
            {t(`${KP}.send.openSettings`)}
          </button>
        </>
      )}
    </p>
  );
}

export default function ProspectingEmailDetail({
  email, t, busy = false, regenerating = false, sending = false,
  sendStatus = null, blocked = false,
  onApprove, onReject, onMarkSent, onRegenerate, onCopy, onSend, onDoNotContact, onOpenSettings,
}) {
  const [language, setLanguage] = useState(email.language || DEFAULT_EMAIL_LANGUAGE);
  // null | "send" | "retry" | "doNotContact"
  const [confirming, setConfirming] = useState(null);
  const blockNoteId = useId();
  useEffect(() => { setLanguage(email.language || DEFAULT_EMAIL_LANGUAGE); }, [email.id, email.language]);
  useEffect(() => { setConfirming(null); }, [email.id]);
  const disabled = busy || regenerating || sending;

  const uncertain = isUncertain(email);
  const blockReason = onSend ? sendBlockReason(sendStatus, email, blocked) : null;
  const lastError = email.last_send_error?.code;

  const confirmSend = () => {
    const forceRetry = confirming === "retry";
    setConfirming(null);
    onSend?.(email, { forceRetry });
  };
  const confirmDoNotContact = () => {
    setConfirming(null);
    onDoNotContact?.(email);
  };

  return (
    <div className="space-y-3" data-testid="prospecting-email-detail">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">{email.contact_name}</p>
          {email.contact_job_title && <p className="text-xs text-gray-500">{email.contact_job_title}</p>}
        </div>
        <EmailStatusBadge status={email.status} t={t} />
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div>
          <dt className="text-gray-500">{t(`${KP}.detail.vacancy`)}</dt>
          <dd className="font-medium text-gray-800">{email.job_title} @ {email.company_name}</dd>
        </div>
        <div>
          <dt className="text-gray-500">{t(`${KP}.detail.to`)}</dt>
          <dd className="font-medium text-gray-800 break-all">{email.to_email}</dd>
        </div>
        <div>
          <dt className="text-gray-500">{t(`${KP}.detail.language`)}</dt>
          <dd className="font-medium text-gray-800" data-testid="email-language">{languageLabel(email.language || DEFAULT_EMAIL_LANGUAGE)}</dd>
        </div>
      </dl>

      {email.contact_review_status === "pending" && ["pending_review", "approved"].includes(email.status) && (
        <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t(`${KP}.detail.pendingContact`)}
        </p>
      )}

      <div>
        <p className="text-xs text-gray-500">{t(`${KP}.detail.subject`)}</p>
        <p className="text-sm font-semibold text-gray-900 whitespace-pre-wrap break-words" data-testid="email-subject">{email.subject}</p>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-2 space-y-2">
        <p className="sr-only">{t(`${KP}.detail.body`)}</p>
        <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed text-gray-700" data-testid="email-body">{email.body}</pre>
        {email.unsubscribe_line && email.status !== "rejected" && (
          <div className="rounded-md border border-dashed border-gray-300 bg-gray-50 px-2 py-1.5" data-testid="email-unsubscribe-line">
            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{t(`${KP}.detail.unsubscribeLabel`)}</p>
            <p className="text-xs text-gray-600 whitespace-pre-wrap">{email.unsubscribe_line}</p>
          </div>
        )}
      </div>

      {blocked && (
        <p className="text-xs font-medium text-gray-600" data-testid="do-not-contact-mark">{t(`${KP}.detail.onDoNotContactList`)}</p>
      )}

      {email.status === "pending_review" && (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <select
            aria-label={t(`${KP}.actions.regenerateLanguage`)}
            value={language}
            disabled={disabled}
            onChange={(event) => setLanguage(event.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs"
          >
            {EMAIL_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
          </select>
          <Action disabled={disabled} aria-busy={regenerating || undefined} onClick={() => onRegenerate?.(email, language)}>
            {regenerating ? t(`${KP}.actions.generating`) : t(`${KP}.actions.regenerate`)}
          </Action>
          <Action variant="danger" disabled={disabled} onClick={() => onReject?.(email)}>{t(`${KP}.actions.reject`)}</Action>
          <Action variant="success" disabled={disabled} onClick={() => onApprove?.(email)}>{t(`${KP}.actions.approve`)}</Action>
        </div>
      )}
      {email.status === "approved" && (
        <div className="space-y-1">
          {uncertain ? (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="send-uncertain">
              {t(`${KP}.send.uncertain`)}
            </p>
          ) : lastError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="send-last-error">
              {fill(t(`${KP}.send.lastError`), { error: errorText(t, lastError) })}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Action disabled={disabled} onClick={() => onCopy?.(email)}>{t(`${KP}.actions.copy`)}</Action>
            <Action variant="danger" disabled={disabled} onClick={() => onReject?.(email)}>{t(`${KP}.actions.reject`)}</Action>
            <Action disabled={disabled} onClick={() => onMarkSent?.(email)}>{t(`${KP}.actions.markSent`)}</Action>
            {onSend && (
              <Action
                variant="primary"
                disabled={disabled || Boolean(blockReason)}
                aria-busy={sending || undefined}
                aria-describedby={blockReason ? blockNoteId : undefined}
                onClick={() => setConfirming(uncertain ? "retry" : "send")}
              >
                {sending ? t(`${KP}.actions.sending`) : t(`${KP}.actions.${uncertain ? "retrySend" : "send"}`)}
              </Action>
            )}
          </div>
          {blockReason && (
            <BlockNote id={blockNoteId} reason={blockReason} sendStatus={sendStatus} t={t} onOpenSettings={onOpenSettings} />
          )}
          <p className="text-right text-xs text-gray-500">{t(`${KP}.actions.markSentHint`)}</p>
        </div>
      )}
      {email.status === "sent" && (
        <p className="text-xs text-gray-600" data-testid="sent-by">
          {email.send_method === "smtp"
            ? fill(t(`${KP}.send.sentBySmtp`), { name: email.sent_by_name || email.sent_by || "—", date: formatDateTime(email.sent_at) })
            : fill(t(`${KP}.send.markedSent`), { name: email.sent_marked_by_name || email.sent_marked_by || "—", date: formatDateTime(email.sent_at) })}
        </p>
      )}

      {onDoNotContact && !blocked && email.to_email && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirming("doNotContact")}
            className="text-xs font-medium text-gray-500 underline hover:text-gray-700 disabled:opacity-60"
          >
            {t(`${KP}.actions.doNotContact`)}
          </button>
        </div>
      )}

      <History email={email} t={t} />

      <ConfirmDialog
        open={confirming === "send" || confirming === "retry"}
        title={t(`${KP}.send.${confirming === "retry" ? "retryTitle" : "confirmTitle"}`)}
        details={<SendSummary email={email} sendStatus={sendStatus} t={t} />}
        warning={t(`${KP}.send.${confirming === "retry" ? "retryWarning" : "confirmWarning"}`)}
        cancelLabel={t(`${KP}.send.cancel`)}
        confirmLabel={t(`${KP}.send.${confirming === "retry" ? "retryButton" : "confirmButton"}`)}
        onCancel={() => setConfirming(null)}
        onConfirm={confirmSend}
      />
      <ConfirmDialog
        open={confirming === "doNotContact"}
        title={t(`${KP}.doNotContact.confirmTitle`)}
        message={fill(t(`${KP}.doNotContact.confirmMessage`), { to: email.to_email || "" })}
        cancelLabel={t(`${KP}.send.cancel`)}
        confirmLabel={t(`${KP}.doNotContact.confirmButton`)}
        onCancel={() => setConfirming(null)}
        onConfirm={confirmDoNotContact}
      />
    </div>
  );
}
