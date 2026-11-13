// "ИИ-обзор для всех" - writes the AI summary for every queued case of a channel that has no sheet
// yet, one case after another, with a progress bar on the Bureau's settings page.
//
// A SERVER-SIDE JOB, NOT A BROWSER LOOP. A loop in the page would stop the moment the moderator
// closed the tab, and two open tabs would run it twice. Here the job belongs to the channel: one at a
// time per channel, the page only starts it, stops it and polls its progress, and reloading the page
// picks the bar up where it is. The state lives in this process's memory - this app runs as a single
// process, and a restart ends a running job (the cases it had not reached simply have no summary yet,
// so pressing the button again continues from there; nothing is lost but the bar).
//
// PACED, AND THE PACE IS SHARED BY EVERY CHANNEL. Gemini's free tier is bounded per minute and per
// day by request count, per API KEY - and there is one key for the whole site. Two channels running a
// batch at once must not double the rate, so the spacing between calls is one module-level slot
// rather than a sleep inside each job. A call that fails on Google falls through to Anthropic (see
// lib/unbanOpinionsGenerator.js), which is paid; the pace is what keeps a long queue from walking
// into Google's per-minute limit and paying for every case after it. The daily quota is a reading in
// AI Studio, not a number here, which is why the page warns about the paid fallback before starting.
//
// A CASE THAT FAILS ON BOTH VENDORS IS SKIPPED, NOT RETRIED. It is counted, its reason is kept for
// the page, and the job moves on: one unreadable dossier must not hold up the rest of the queue, and
// a retry loop is a way to pay twice for the same refusal. Pressing the button again picks it up.
//
// Everything that touches Mongo or a model is injected (`listCandidates`, `runCase`), so the job
// itself is testable without either - see tests/unbanSummaryBatch.test.js.

// Minimum spacing between two summary calls, across all channels. Gemini's free-tier per-minute
// limit is a reading that has moved before; eight seconds is under ten calls a minute, with room
// left for the single-case button on the desk, which is not paced.
const DEFAULT_PACE_MS = 8000;
// How many failures the page lists by name. The counter keeps counting past it.
const MAX_ERRORS_KEPT = 10;

/**
 * Which queued cases still need a summary: those with no sheet of EITHER shape.
 *
 * A case argued under the old prosecutor/advocate hearing is skipped too. Its sheet is still on the
 * desk and still readable; overwriting it with a summary would destroy something a moderator may
 * already have read and decided from, to buy a shorter version of the same thing.
 *
 * @param {object[]} cases          queued UnbanRequests documents (`_id`, `userLogin`, ...)
 * @param {Set<string>} withSheets  case ids that already have an UnbanExpertOpinions document
 * @returns {{id: string, login: string}[]}  in the order given
 */
function selectCasesForSummary(cases, withSheets) {
  const seen = new Set();
  const out = [];
  for (const c of cases || []) {
    if (!c || !c._id) continue;
    const id = String(c._id);
    if (seen.has(id) || (withSheets && withSheets.has(id))) continue;
    seen.add(id);
    out.push({ id, login: c.userDisplayName || c.userLogin || "" });
  }
  return out;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.wake = () => { clearTimeout(timer); resolve(); };
  });
}

/**
 * The registry of jobs, one per channel. A factory rather than a module singleton so a test gets a
 * fresh registry with a fake clock; the route keeps exactly one.
 *
 * @param {object}   [opts]
 * @param {number}   [opts.paceMs]
 * @param {function} [opts.now]    () => ms
 * @param {function} [opts.sleep]  (ms, signal) => Promise; must honour signal.wake for a prompt stop
 */
function createSummaryBatches({ paceMs = DEFAULT_PACE_MS, now = () => Date.now(), sleep = defaultSleep } = {}) {
  const jobs = new Map();
  // The shared slot: no call starts before this moment, whichever channel's job it belongs to.
  let nextSlotAt = 0;

  function snapshot(job) {
    if (!job) return null;
    return {
      status: job.status,
      total: job.total,
      done: job.done,
      failed: job.failed,
      skipped: job.skipped,
      processed: job.done + job.failed + job.skipped,
      current: job.current ? { ...job.current } : null,
      errors: job.errors.map((e) => ({ ...e })),
      startedAt: new Date(job.startedAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      startedBy: job.startedBy,
      stopRequested: job.stopRequested,
    };
  }

  async function waitForSlot(job) {
    for (;;) {
      if (job.stopRequested) return false;
      const wait = nextSlotAt - now();
      if (wait <= 0) {
        nextSlotAt = now() + paceMs;
        return true;
      }
      job.signal = {};
      await sleep(wait, job.signal);
      job.signal = null;
    }
  }

  async function run(job, candidates, runCase) {
    try {
      for (const candidate of candidates) {
        if (!(await waitForSlot(job))) break;
        job.current = { id: candidate.id, login: candidate.login };
        try {
          const outcome = await runCase(candidate);
          if (outcome === "skipped") job.skipped += 1;
          else job.done += 1;
        } catch (err) {
          job.failed += 1;
          job.errors.push({
            id: candidate.id,
            login: candidate.login,
            reason: (err && (err.reason || err.message)) || "error",
          });
          if (job.errors.length > MAX_ERRORS_KEPT) job.errors.shift();
          console.warn(
            `[summary-batch] ${job.key}: case ${candidate.id} failed: ${err && (err.reason || err.message)}`
          );
        }
        job.current = null;
      }
    } finally {
      job.current = null;
      job.status = job.stopRequested ? "stopped" : "done";
      job.finishedAt = now();
    }
  }

  return {
    /**
     * Starts the job for a channel, unless one is already running there.
     *
     * The candidates are read HERE, at start, and fixed for the job: the bar's denominator must not
     * move under the moderator's eyes. A case that is stamped or summarised by hand while the job
     * runs is still in the list, and `runCase` is expected to re-check and answer "skipped".
     *
     * @param {string}   key            channel login
     * @param {object}   params
     * @param {function} params.listCandidates  async () => [{id, login}]
     * @param {function} params.runCase         async ({id, login}) => "done" | "skipped"; throws on failure
     * @param {string}  [params.startedBy]      the moderator's login, for the page
     * @returns {Promise<{ok: true, job: object} | {ok: false, reason: string, job?: object}>}
     */
    async start(key, { listCandidates, runCase, startedBy = null }) {
      const existing = jobs.get(key);
      if (existing && existing.status === "running") {
        return { ok: false, reason: "already_running", job: snapshot(existing) };
      }
      // Claimed before the (awaited) candidate read, so two presses arriving together cannot both
      // pass the check above.
      const job = {
        key,
        status: "running",
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        current: null,
        errors: [],
        startedAt: now(),
        finishedAt: null,
        startedBy,
        stopRequested: false,
        signal: null,
      };
      jobs.set(key, job);

      // Puts back whatever finished job was there before, so a refused start does not wipe the
      // last run's result off the page.
      const restore = () => {
        if (existing) jobs.set(key, existing);
        else jobs.delete(key);
      };

      let candidates;
      try {
        candidates = await listCandidates();
      } catch (err) {
        restore();
        throw err;
      }
      if (!candidates.length) {
        restore();
        return { ok: false, reason: "nothing_to_do" };
      }

      job.total = candidates.length;
      job.promise = run(job, candidates, runCase);
      return { ok: true, job: snapshot(job) };
    },

    /** Asks a running job to stop after the case in progress. The model call already made is kept. */
    stop(key) {
      const job = jobs.get(key);
      if (!job || job.status !== "running") return { ok: false, reason: "not_running", job: snapshot(job) };
      job.stopRequested = true;
      if (job.signal && job.signal.wake) job.signal.wake();
      return { ok: true, job: snapshot(job) };
    },

    status(key) {
      return snapshot(jobs.get(key));
    },

    /** True while a running job of this channel is writing exactly this case. */
    isWriting(key, caseId) {
      const job = jobs.get(key);
      return Boolean(job && job.status === "running" && job.current && job.current.id === String(caseId));
    },

    // For tests: the promise of a channel's running loop.
    _promise(key) {
      const job = jobs.get(key);
      return job ? job.promise : null;
    },
  };
}

module.exports = {
  createSummaryBatches,
  selectCasesForSummary,
  DEFAULT_PACE_MS,
  MAX_ERRORS_KEPT,
};
