// Reports (P12-T04): what can be reported, why, and the limits.
//
// `message` is accepted by the model so that messaging (P11) needs no
// migration, but the service refuses it until messages exist.
const REPORT_KINDS = Object.freeze([
  { value: "listing", label: "Listing" },
  { value: "review", label: "Review" },
  { value: "user", label: "Member" },
  { value: "message", label: "Message" },
]);

// The kinds a person can report today.
const REPORTABLE_KINDS = Object.freeze(["listing", "review", "user"]);

const REPORT_REASONS = Object.freeze([
  { value: "spam", label: "Spam or an advert" },
  { value: "scam", label: "Scam or fraud" },
  { value: "inaccurate", label: "Inaccurate or misleading" },
  { value: "offensive", label: "Offensive, hateful or harassing" },
  { value: "unsafe", label: "Unsafe or illegal" },
  { value: "privacy", label: "Shares private information" },
  { value: "other", label: "Something else" },
]);

const REPORT_STATUSES = Object.freeze(["open", "resolved", "dismissed"]);

const LIMITS = Object.freeze({
  detailsMax: 1000,
  otherMin: 10, // "Something else" needs a few words
  perDay: 20, // reports one person may send in 24 hours (durable, all instances)
});

const values = (list) => list.map((item) => item.value);

module.exports = {
  REPORT_KINDS,
  REPORTABLE_KINDS,
  REPORT_REASONS,
  REPORT_STATUSES,
  LIMITS,
  KIND_VALUES: values(REPORT_KINDS),
  REASON_VALUES: values(REPORT_REASONS),
};
