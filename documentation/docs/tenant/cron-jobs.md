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

## Run, stop, and delete

Each task row has quick actions:

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
