import {
  MAIL_BAN_EXPIRY_HOURS_DEFAULT,
  MAIL_BAN_EXPIRY_HOURS_MAX,
  MAIL_BAN_EXPIRY_HOURS_MIN,
} from '@insula/api-contracts';

const INPUT_CLASS =
  'w-28 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50';

/** What the operator is editing: the hours as typed, and whether bans should never lift. */
export interface MailBanExpiryDraft {
  readonly hours: string;
  readonly never: boolean;
}

/** The draft for a stored value (null = never). "Never" still pre-fills the default hours. */
export function draftFromSetting(value: number | null | undefined): MailBanExpiryDraft {
  return value === null
    ? { hours: String(MAIL_BAN_EXPIRY_HOURS_DEFAULT), never: true }
    : { hours: String(value ?? MAIL_BAN_EXPIRY_HOURS_DEFAULT), never: false };
}

/**
 * The value to save: whole hours, null for "never", or undefined when the typed
 * hours are not a whole number in range (the form refuses to save then).
 */
export function settingFromDraft(draft: MailBanExpiryDraft): number | null | undefined {
  if (draft.never) return null;
  const text = draft.hours.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const hours = Number(text);
  return hours >= MAIL_BAN_EXPIRY_HOURS_MIN && hours <= MAIL_BAN_EXPIRY_HOURS_MAX ? hours : undefined;
}

interface MailBanExpirySectionProps {
  readonly draft: MailBanExpiryDraft;
  readonly onChange: (draft: MailBanExpiryDraft) => void;
  readonly disabled?: boolean;
}

/**
 * How long the mail server keeps an AUTOMATIC ban. Stalwart's own default is
 * forever, which locks a shared or reassigned address out for good with no
 * trace in the panel; the platform default is 24 hours.
 */
export default function MailBanExpirySection({ draft, onChange, disabled }: MailBanExpirySectionProps) {
  const invalid = settingFromDraft(draft) === undefined;
  return (
    <fieldset
      className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3"
      data-testid="mail-ban-expiry-section"
    >
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
        Automatic IP Bans
      </legend>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        The mail server blocks an address on its own after repeated failed
        logins, port scans or exploit probes, idle connections, or mail to
        unknown recipients — on every mail port and webmail. Choose how long such
        a ban lasts. Manual bans are not affected, and bans that already exist
        keep the lifetime they were created with.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="mail-ban-expiry-hours" className="text-sm text-gray-700 dark:text-gray-300">
          Lift automatic bans after
        </label>
        <input
          id="mail-ban-expiry-hours"
          type="number"
          inputMode="numeric"
          min={MAIL_BAN_EXPIRY_HOURS_MIN}
          max={MAIL_BAN_EXPIRY_HOURS_MAX}
          step={1}
          value={draft.hours}
          onChange={(e) => onChange({ ...draft, hours: e.target.value })}
          disabled={disabled || draft.never}
          aria-invalid={invalid}
          className={`${INPUT_CLASS} ${
            invalid ? 'border-amber-400 dark:border-amber-500 focus:border-amber-500 focus:ring-amber-500' : ''
          }`}
          data-testid="mail-ban-expiry-hours"
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">hours</span>
      </div>
      {invalid && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="mail-ban-expiry-invalid">
          Enter a whole number of hours from {MAIL_BAN_EXPIRY_HOURS_MIN} to {MAIL_BAN_EXPIRY_HOURS_MAX}.
        </p>
      )}
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={draft.never}
          onChange={(e) => onChange({ ...draft, never: e.target.checked })}
          disabled={disabled}
          className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700 text-brand-600 focus:ring-brand-500"
          data-testid="mail-ban-expiry-never"
        />
        Never lift them (permanent bans — the mail server&apos;s own default)
      </label>
    </fieldset>
  );
}
