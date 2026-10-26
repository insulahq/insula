import {
  MAIL_SPAM_JUNK_SCORE_DEFAULT,
  MAIL_SPAM_JUNK_SCORE_MAX,
  MAIL_SPAM_JUNK_SCORE_MIN,
  MAIL_SPAM_REJECT_SCORE_MAX,
} from '@insula/api-contracts';

const INPUT_CLASS =
  'w-24 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50';
const INVALID_CLASS = 'border-amber-400 dark:border-amber-500 focus:border-amber-500 focus:ring-amber-500';

/** Pre-filled in the refuse box while refusing is off, so turning it on starts from a sensible value. */
const SUGGESTED_REJECT_SCORE = 15;

/** What the operator is editing: the scores as typed, and whether high scores are refused at all. */
export interface SpamFilterDraft {
  readonly junk: string;
  readonly reject: string;
  readonly refuse: boolean;
}

export interface SpamThresholds {
  readonly junk: number;
  /** null = nothing is refused on score. */
  readonly reject: number | null;
}

/** The draft for the stored thresholds (reject null = refusing is off). */
export function spamDraftFromSettings(junk: number | undefined, reject: number | null | undefined): SpamFilterDraft {
  return {
    junk: String(junk ?? MAIL_SPAM_JUNK_SCORE_DEFAULT),
    reject: String(reject ?? SUGGESTED_REJECT_SCORE),
    refuse: reject !== null && reject !== undefined,
  };
}

const parseScore = (text: string): number | undefined => {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Math.round(Number(t) * 10) / 10;
};

/**
 * The thresholds to save, or undefined when the draft is not valid: a Junk
 * score outside its range, or a refuse score that is out of range or not
 * above the Junk score (it would refuse mail that should go to Junk).
 */
export function spamThresholdsFromDraft(draft: SpamFilterDraft): SpamThresholds | undefined {
  const junk = parseScore(draft.junk);
  if (junk === undefined || junk < MAIL_SPAM_JUNK_SCORE_MIN || junk > MAIL_SPAM_JUNK_SCORE_MAX) return undefined;
  if (!draft.refuse) return { junk, reject: null };
  const reject = parseScore(draft.reject);
  if (reject === undefined || reject <= junk || reject > MAIL_SPAM_REJECT_SCORE_MAX) return undefined;
  return { junk, reject };
}

interface MailSpamFilterSectionProps {
  readonly draft: SpamFilterDraft;
  readonly onChange: (draft: SpamFilterDraft) => void;
  readonly disabled?: boolean;
}

/**
 * The mail server's spam thresholds. One pair for the whole server: Stalwart
 * scores every incoming message against a single threshold, not one per
 * domain. DMARC enforcement does not depend on them and has no switch.
 */
export default function MailSpamFilterSection({ draft, onChange, disabled }: MailSpamFilterSectionProps) {
  const invalid = spamThresholdsFromDraft(draft) === undefined;
  const junkInvalid = invalid && spamThresholdsFromDraft({ ...draft, refuse: false }) === undefined;
  const rejectInvalid = invalid && !junkInvalid;
  return (
    <fieldset
      className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3"
      data-testid="spam-filter-section"
    >
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
        Spam Filter
      </legend>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        The mail server scores every incoming message. These thresholds apply to
        every domain it hosts — the mail server has one pair, not one per domain.
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="spam-filter-dmarc-note">
        Sender authentication (DMARC) is always enforced: a message that fails
        DMARC for a domain whose policy is <code className="font-mono">reject</code>{' '}
        is refused, and one whose policy is <code className="font-mono">quarantine</code>{' '}
        goes to Junk. With refusing on, the quarantine failure is scored just
        under the refuse score, so the DMARC failure alone never refuses a
        message, but any further spam signal will.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="spam-junk-score" className="text-sm text-gray-700 dark:text-gray-300">
          Move to Junk at a score of
        </label>
        <input
          id="spam-junk-score"
          type="number"
          inputMode="decimal"
          min={MAIL_SPAM_JUNK_SCORE_MIN}
          max={MAIL_SPAM_JUNK_SCORE_MAX}
          step={0.1}
          value={draft.junk}
          onChange={(e) => onChange({ ...draft, junk: e.target.value })}
          disabled={disabled}
          aria-invalid={junkInvalid}
          className={`${INPUT_CLASS} ${junkInvalid ? INVALID_CLASS : ''}`}
          data-testid="spam-junk-score"
        />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          (default {MAIL_SPAM_JUNK_SCORE_DEFAULT})
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={draft.refuse}
            onChange={(e) => onChange({ ...draft, refuse: e.target.checked })}
            disabled={disabled}
            className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700 text-brand-600 focus:ring-brand-500"
            data-testid="spam-refuse-enabled"
          />
          Refuse messages at a score of
        </label>
        <input
          id="spam-reject-score"
          aria-label="Refuse at score"
          type="number"
          inputMode="decimal"
          min={MAIL_SPAM_JUNK_SCORE_MIN}
          max={MAIL_SPAM_REJECT_SCORE_MAX}
          step={0.1}
          value={draft.reject}
          onChange={(e) => onChange({ ...draft, reject: e.target.value })}
          disabled={disabled || !draft.refuse}
          aria-invalid={rejectInvalid}
          className={`${INPUT_CLASS} ${rejectInvalid ? INVALID_CLASS : ''}`}
          data-testid="spam-reject-score"
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        A refused message never reaches a mailbox; the sending server gets the
        bounce. Off by default, as on the mail server itself.
      </p>
      {invalid && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="spam-filter-invalid">
          {junkInvalid
            ? `Enter a Junk score from ${MAIL_SPAM_JUNK_SCORE_MIN} to ${MAIL_SPAM_JUNK_SCORE_MAX}.`
            : `Enter a refuse score above the Junk score, up to ${MAIL_SPAM_REJECT_SCORE_MAX} — or turn refusing off.`}
        </p>
      )}
    </fieldset>
  );
}
