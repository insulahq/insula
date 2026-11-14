-- Wrong step-up passwords, counted per credential holder.
--
-- /me/step-up/password was throttled per IP only (its rate limit runs before
-- the token is read), so someone holding a stolen session could guess the
-- password from many addresses. Same scheme as TOTP (user_totp): an attempt
-- is taken from the holder's allowance atomically before the password is
-- checked, a right password gives the window back, and past the allowance
-- every attempt is refused until the window has passed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS step_up_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS step_up_failed_window_started_at TIMESTAMPTZ;
