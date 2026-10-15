export const decodeHtmlEntities = (value = "") => {
  let decoded = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    const next = decoded
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/g, "'");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
};

export const cleanProposalHtml = (html = "") => decodeHtmlEntities(html)
  .replace(/```html/g, "")
  .replace(/```/g, "")
  .replace(/<br\s*\/?>/gi, "<br />")
  .trim();

export const stripHtml = (html = "") => cleanProposalHtml(html)
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<\/(p|li|h1|h2|h3|tr|section|div|ol|ul)>/gi, "\n")
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, "\"")
  .replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

export const escapeHtml = (value = "") => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");
