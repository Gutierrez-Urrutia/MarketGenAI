/**
 * ProspectingEmailDetail — one prospecting email (RF-VTA-16) in «Alcance».
 *
 * Subject and body are model output: they are rendered as plain text only
 * (text nodes inside <pre>), never as HTML. The actions depend on the status:
 * pending_review → regenerate (optionally in another language), reject,
 * approve; approved → copy, mark as sent, reject; sent / rejected → none.
 * «Copiar» never calls the API nor changes the email.
 */
import { useEffect, useState } from "react";

import { DEFAULT_EMAIL_LANGUAGE, EMAIL_LANGUAGES, languageLabel } from "./prospectingEmails";
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

export default function ProspectingEmailDetail({
  email, t, busy = false, regenerating = false, onApprove, onReject, onMarkSent, onRegenerate, onCopy,
}) {
  const [language, setLanguage] = useState(email.language || DEFAULT_EMAIL_LANGUAGE);
  useEffect(() => { setLanguage(email.language || DEFAULT_EMAIL_LANGUAGE); }, [email.id, email.language]);
  const disabled = busy || regenerating;

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
      <div className="rounded-lg border border-gray-200 bg-white p-2">
        <p className="sr-only">{t(`${KP}.detail.body`)}</p>
        <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed text-gray-700" data-testid="email-body">{email.body}</pre>
      </div>

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
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Action disabled={disabled} onClick={() => onCopy?.(email)}>{t(`${KP}.actions.copy`)}</Action>
            <Action variant="danger" disabled={disabled} onClick={() => onReject?.(email)}>{t(`${KP}.actions.reject`)}</Action>
            <Action variant="primary" disabled={disabled} onClick={() => onMarkSent?.(email)}>{t(`${KP}.actions.markSent`)}</Action>
          </div>
          <p className="text-right text-xs text-gray-500">{t(`${KP}.actions.markSentHint`)}</p>
        </div>
      )}

      <History email={email} t={t} />
    </div>
  );
}
