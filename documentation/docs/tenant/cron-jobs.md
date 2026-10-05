---
verified: 2026.6.7
---

# Scheduled tasks (cron jobs)

A **scheduled task** (also called a *cron job*) runs something automatically on
a repeating timetable — for example, "every night at 2 a.m." Open **Scheduled
Tasks** from the left menu.

!!! abstract "Two kinds of task"
    - **Webcron** — the platform visits a URL on your schedule (great for apps
      that expect a `cron.php`-style trigger).
    - **Deployment** — the platform runs a command inside one of your running
      apps (great for framework commands like `php artisan schedule:run`).

The page lists your tasks with their schedule, type, target, whether they're
enabled, and the result of the last run.

## Create a scheduled task

1. Click **Add Cron Job**.
2. Choose the **Type** — **Webcron** or **Deployment**.
3. Fill in the type-specific fields:

    === "Webcron"

        - **URL** — the web address to call (e.g. `https://example.com/cron.php`).
        - **HTTP Method** — usually **GET**; **POST** or **PUT** are also
          available.

    === "Deployment"

        - **Deployment** — which running app to run the command in (only running
          apps appear).
        - **Command** — the command line to execute (e.g.
          `php artisan schedule:run`, or `php /var/www/html/admin/cli/cron.php`
          for Moodle). It runs inside the app's own container, as that
          container's user, through a shell — so pipes, `&&` and redirects work
          the same way they would in a terminal there.

        !!! note "Apps that run more than one container"
            Some applications bring their own database or cache alongside the
            web container. When the platform cannot tell which of them the
            command is meant for, it refuses to run rather than guess, and the
            task reports that as the failure reason.

4. Fill in the common fields:
    - **Name** — a label for you (e.g. `daily-backup`).
    - **Schedule (cron)** — when it runs, in cron format (see below).
    - **Timezone** — optional. The clock the schedule is read on. Left alone it
      follows the **platform timezone**, and the picker shows you which zone
      that is; change the platform's and every task following it moves with it.
      Set one here only when a task belongs to a different region — a school in
      another country, say — and it stays pinned regardless of platform changes.
    - **Timeout (seconds)** — optional. How long **one run** may take before
      the platform gives up on it and records a failure. Leave it blank for the
      default: **30 seconds** for a webcron, **300 seconds** for a deployment
      command. Raise it for an application cron that legitimately runs for
      minutes — a Moodle site rebuilding its search index or running a course
      backup, for instance. The most you can set is one hour.
5. Optionally tick **Email when a scheduled run fails** — see
   [Email when a task fails](#email-when-a-task-fails) below.
6. Click **Add**. New tasks start **enabled**.

### Writing the schedule

The schedule uses standard **cron** notation — five fields:
`minute hour day-of-month month day-of-week`.

| You want… | Enter |
|---|---|
| Every 15 minutes | `*/15 * * * *` |
| Every hour, on the hour | `0 * * * *` |
| Every day at 2:00 a.m. | `0 2 * * *` |
| Every Monday at 6:00 a.m. | `0 6 * * 1` |

!!! tip "Cron format help"
    If you're unsure, an online "crontab generator" can turn plain English into
    the five-field expression to paste here.

!!! warning "A task never overlaps itself"
    The platform will not start a run while the previous one is still going.
    A task is claimed for the whole of its run, so a schedule of `* * * * *`
    on a job that takes three minutes does **not** give you three runs at
    once — it gives you one run roughly every three to four minutes, and the
    schedule you asked for is quietly out of reach.

    If a task is running further apart than its schedule says, look at how
    long its runs take (**Last Run** shows the duration) before changing the
    schedule. An application cron that idles deliberately — many keep polling
    for work for a fixed period after finishing — spends that whole time
    holding its slot, and shortening *that* setting is usually what fixes the
    interval.

!!! info "Which clock a schedule uses"
    A schedule is read on the task's **timezone** — its own if you set one,
    otherwise the platform's. `0 3 * * *` means 3 a.m. on that clock, and it
    stays 3 a.m. on both sides of a daylight-saving change.

    Daylight saving has two edges, and both are handled deliberately:

    - **Spring forward.** The hour that the clocks skip does not exist, so a
      task scheduled inside it is **passed over that day** rather than run an
      hour early. A task at 2:30 a.m. in a zone that jumps 2 a.m. → 3 a.m.
      simply does not run on that one night.
    - **Autumn back.** The repeated hour happens twice, so a task scheduled
      inside it runs at the **first** occurrence — and may run again at the
      second, because those are genuinely two different moments and skipping
      one would mean silently dropping a run.

## Change a saved task

Click the **pencil** on a task's row. It opens the same form you created it
with, filled in, and the button reads **Save Changes**. Everything is editable
— name, schedule, the URL or command, timeout, timezone and who is emailed on
failure — so a typo in a
cron expression is a correction, not a reason to delete the task and start
over (which would also throw away its run history).

Changes apply from the **next** run; a run already in flight is not
interrupted.

!!! note "Two things behave specially"
    - **Type is fixed.** A task cannot be switched between *Webcron* and
      *Deployment* once saved — the type decides which fields the platform
      reads. To change it, delete the task and create a new one.
    - **Clearing a field restores the default.** Empty the **Timeout** or
      **Timezone** box and save, and that task goes back to the default (30 or
      300 seconds by type, and the platform's clock) rather than keeping what
      was there before.

## Email when a task fails

Every failed scheduled run already appears in your panel's notifications, and
your account's administrators also get it by email if their own notification
settings say so. A task can additionally **email specific addresses** when it
fails — useful when the person who has to fix it rarely opens the panel. This
is **off** for every task until you switch it on.

1. Open the task's form (**Add Cron Job**, or the **pencil** on a saved task).
2. Tick **Email when a scheduled run fails**.
3. Choose who gets it — at least one of:
    - **Tenant email** — your account's primary email address. The form shows
      which address that is. It is looked up when the email is sent, so if your
      account's primary email changes, the task follows it.
    - **Additional address** — any one other address, for example a
      developer or an operations mailbox.
4. Save.

The email names the task, your account, the schedule and its timezone, the
reason it failed (the HTTP status or exit code, and the start of the output),
when it happened, and a link to this page.

!!! info "How many emails you can get"
    - **At most one email per task per day** (UTC) while it keeps failing. A
      task broken on an every-minute schedule sends one email, not hundreds.
      The next day's first failure emails again. A task that is deleted and
      created again counts as a new task.
    - **At most 20 failure emails per day across all of your account's tasks**
      combined, however many tasks there are or have been. Failures beyond
      that still show in the panel.
    - **Run Now never emails** — you are looking at the result already.
    - If the address you enter also belongs to one of your account's
      administrators who already got this failure by email, they get it once,
      not twice.

To stop the emails, untick **Email when a scheduled run fails** and save. The
addresses you entered are kept, so switching it back on later restores them.

Tasks that email on failure show a small **envelope** next to their name;
hover it to see who is emailed.

## Run, stop, and delete

Each task row has quick actions:

- **Edit** (pencil) — change the task's settings; see
  [Change a saved task](#change-a-saved-task) above.
- **Stop / Start** (solid square, or a play triangle once stopped) — disable or
  re-enable the task. A stopped task keeps its settings but won't run on
  schedule.
- **Run Now** (lightning bolt) — trigger the task immediately, without waiting
  for its schedule. Handy for testing. Running a stopped task does **not**
  re-enable it: it fires once and the task stays stopped.
- **Delete** (trash icon) — remove the task (asks you to confirm).

## Checking results

The **Last Run** column shows how the most recent run went:

- A status badge — **success**, **failed**, or **running**.
- How long it took.
- The result code: for a **webcron** task the HTTP response code returned by
  the URL, and for a **deployment** task the command's **exit code** (shown as
  `exit 0`, `exit 1`, and so on). `exit 0` means the command finished
  normally — anything else is a failure, and `exit 127` almost always means the
  command or a program it calls was not found in the app's container.

A task that has never run shows **Never**.

!!! warning "A run that hits the timeout is not necessarily stopped"
    The timeout is how long the platform **waits**. For a deployment task, the
    command may carry on running inside your app's container after the wait
    ends — the platform stops watching, it does not reach in and kill it. If a
    task regularly times out, raise its timeout rather than leaving it to be
    abandoned halfway through every run.

!!! note "What you can see"
    The panel shows the **status, timing and output of the most recent run**
    per task. For a deployment task the output is what the command printed
    (the end of it, if it printed a lot — that is where an error usually is).
    If a task keeps failing, check the target it points at: for a webcron,
    open the URL yourself; for a deployment task, check the app's **Logs** on
    the [Applications](deployments-and-applications.md) page.

!!! info "Limits depend on your plan"
    How many tasks you can create, and the resources each run gets, are set by
    your plan. If you hit a limit, contact your provider.
