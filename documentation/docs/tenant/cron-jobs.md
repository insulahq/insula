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
    - **Timeout (seconds)** — optional. How long **one run** may take before
      the platform gives up on it and records a failure. Leave it blank for the
      default: **30 seconds** for a webcron, **300 seconds** for a deployment
      command. Raise it for an application cron that legitimately runs for
      minutes — a Moodle site's `admin/cli/cron.php` takes around three minutes
      on its own, and longer when it runs a course backup or rebuilds its
      search index. The most you can set is one hour.
5. Click **Add**. New tasks start **enabled**.

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

!!! warning "Schedules are in UTC"
    Times are interpreted in **UTC**, not your local time zone. If you are on
    Central European Summer Time (UTC+2) and you ask for `0 3 * * *`, the task
    runs at 5 a.m. where you are. Subtract your offset when you write the
    schedule.

## Run, pause, and delete

Each task row has quick actions:

- **Run Now** (circular-arrow icon) — trigger the task immediately, without
  waiting for its schedule. Handy for testing.
- **Pause / Start** (pause or play icon) — disable or re-enable the task. A
  paused task keeps its settings but won't run on schedule.
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
