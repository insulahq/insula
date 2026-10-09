---
verified: 2026.6.7
---

# Account & security

This page covers your personal profile, signing-in security (password and
passkeys), notification preferences, and adding teammates.

## Your profile

Open the **user menu** (circle, top-right) → **Settings**, or go to **User
Settings**. Under **Profile Information** you can change your:

- **Full name**
- **Email** (your sign-in address)
- **Timezone** — controls how dates and times are shown to you. Leave blank to
  use the system default.

Click **Save Changes**.

## Change your password

Two ways to do it:

- **User Settings** page → **Change Password** section, or
- the **user menu** (top-right) → **Change Password**.

Enter your **current password**, then your **new password** twice, and submit.

!!! tip "Choose a strong password"
    Use a long, unique passphrase. Even better, add a **passkey** (below) so you
    can sign in without typing a password at all.

## Passkeys

A **passkey** lets you sign in with your device's fingerprint, face, or PIN
instead of a password. It can't be guessed or phished, and it is already two
factors on its own (the device, plus the fingerprint or PIN that unlocks it).

Manage passkeys under **User Settings** → **Passkeys**.

**Add a passkey**

1. Type a **nickname** (e.g. "iPhone", "work laptop", "YubiKey").
2. Click **Add passkey** and follow your device's prompt.

The passkey appears in **Registered passkeys** with whether it's synced across
devices and when it was last used. Delete one anytime.

**Turn on passkey sign-in**

Once you have at least one passkey, choose **Passkey sign-in on**: the sign-in
page's **Sign in with passkey** button then signs you in with the passkey
alone — no email or password. Your password keeps working too. Removing your
last passkey turns passkey sign-in off again.

!!! info "Browser support"
    Passkeys need a recent Chrome, Safari, Firefox, or Edge. If your browser
    doesn't support them, the page tells you and the passkey options stay
    disabled.

## Authenticator app (two-step sign-in)

To protect your **password** sign-in, add a 6-digit code from an authenticator
app (1Password, Google Authenticator, Microsoft Authenticator, Aegis, …).
It is optional. With it on, signing in with your password takes two steps:
the password, then the current code from the app. Signing in with a passkey
does not ask for a code.

So you can sign in in one of three ways: email + password, a passkey, or —
with the authenticator app on — email + password + code.

**Set it up** under **User Settings** → **Authenticator app**:

1. Click **Set up authenticator app**.
2. Scan the QR code with your app (or type in the key shown beside it).
3. Enter the 6-digit code the app shows and click **Turn on**.
4. **Store the backup codes** that appear. Each one signs you in once
   without your phone, and they are shown only this one time — copy or
   download them, then tick *I have stored these codes*.

**At sign-in**, after your password, enter the code from the app. Lost your
phone? Choose **Use a backup code** and enter one of your backup codes.

**Later**, the same section shows how many backup codes you have left (it
warns when only a few remain). **New backup codes** replaces the whole set;
**Turn off** removes the app. Both ask for a current code or a backup code.

!!! warning "Lost your phone and your backup codes?"
    Ask your platform administrator: they can remove the authenticator app
    from your account, after which you sign in with your password alone and
    can set it up again.

## Notification preferences

Choose which events notify you and how. Go to **Settings** → **Notification
Preferences** (or **Notifications** → preferences).

- **Categories** — a grid where you turn each event category on or off per
  **channel** (in-app, email). Some categories are **mandatory** (security and
  account-state events) and can't be switched off — they're marked with a lock.
- **Delivery Settings** — set **Quiet hours** (start/end time) to silence
  non-critical notifications overnight, a **Digest mode**, and your
  **timezone**.

Click **Save** in each section to apply.

Your full message history lives under **Notifications** in the left menu.
Filter the list by **Read state**, and read the counter beside it: the first
number is how many messages the filter is showing, the second is how many
unread you have in total — the same number as the bell badge.

Two buttons on the right act on the whole account, not just the messages on
screen:

- **Mark All As Read** clears every unread message, which is what makes the
  bell badge go to zero.
- **Delete All** removes every message and asks you to confirm first. It
  cannot be undone, and it reaches messages the current filter is hiding —
  so the confirmation says so, and tells you afterwards how many were
  removed.

Each message also has its own mark-as-read and delete buttons.

## Sub-users — add teammates

You can let colleagues into your account with their own login. Open **Users**
from the left menu.

**Add a user**

1. Click **Add User**.
2. Enter their **email** and **full name**. There is no password field — the
   platform generates a strong password for you.
3. Choose a **Role**:
    - **Member (read-only)** — can view your account but not change things.
    - **Administrator (can manage team)** — can add, edit, and remove users, and
      manage your account.
4. Create the user. The generated password appears once, in an amber box with
   a copy button. **Copy it now — it is never shown again.** Share it with
   your colleague over a secure channel; they are not emailed automatically.

!!! note "Passwords are always generated, never chosen"
    You cannot type a password for someone else, here or when resetting one.
    The password is stored only as a one-way hash, which is why it can be
    shown at the moment it is created and never again. Your colleague can
    change it themselves under **Change your password** once they sign in.

**Manage users**

From the list you can **edit** a user's name and role, **enable/disable** their
access, **reset their password**, or **delete** them. Disabling immediately
removes access without deleting the account.

**Reset a user's password**

Click the key icon on their row. The dialog asks you to confirm, then
generates a **new** password and shows it once — you don't choose it. Their
old password stops working immediately and they are signed out everywhere, so
pass the new one on promptly and securely.

!!! note "Who can manage the team"
    Only administrators (and your provider's support staff) can add or change
    users. Members see the team list but the management buttons are hidden for
    them.

!!! info "Account-wide settings live in Settings"
    The **Settings** page shows your **subscription** (plan, status, renewal
    date, and limits) and links to **Access & Network Providers** used by the
    advanced Access Control and network features. To change your plan, contact
    your provider's support.
