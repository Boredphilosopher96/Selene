# Native Electron performance qualification

The Electron shell is measured separately from headless graph/service benchmarks. Run a
production build on a real Linux desktop with a functioning Secret Service, without weakening
sandboxing, web security, or protected storage:

```sh
bun run build
mkdir -p artifacts/performance
node scripts/performance/measure-desktop.mjs . artifacts/performance/native.json
node scripts/performance/check-desktop-report.mjs artifacts/performance/native.json
```

The existing native-host guard remains in force. See
[native Electron verification](native-electron-verification.md) for platform restrictions.
The harness refuses an insecure native window or unavailable protected storage. It uses one
isolated temporary profile, closes each owned app, observes process identities before cleanup,
and removes only its own temporary profile.

## What the receipt means

- Production source commit, tracked-source diff digest, harness digest, and every emitted
  main/preload/renderer file's SHA-256 identify the tested input
- Five first/warm-profile launches are observed by default. OS page cache is not flushed
- UI timings include Playwright input/wait overhead, visible source-backed preview content,
  and two renderer animation-frame callbacks. They are not physical-display frame timings
- Nearest-rank p50/p95 values describe the recorded samples. Five launches or twelve opens
  cannot establish population-wide tail-latency guarantees
- Initial resource inventory uses ResourceTiming when available. Native file-backed loads can
  omit it; the explicit fallback inventories linked script/stylesheet/modulepreload elements,
  and is labeled as an initial DOM-linked inventory, not a complete dynamic-request trace
- The independent native startup resource regression test observes file-backed requests through
  CDP during an idle launchpad reload. This is a resource-graph check, not a startup-time sample
- CPU is recorded from Electron process metrics. Working sets are KiB and can include shared
  pages; their sum is not a deduplicated system-RAM measurement. JS heap/DOM counters describe
  the inspected renderer. Sampled maxima are not exact peaks
- The default 180-second sustained timebox includes a separately reported 10,000-call IPC
  notice burst, followed by repeated authenticated selections, preview refreshes, and project
  switches. Cycle counts can differ between versions. It is not three minutes of UI work in
  addition to the burst
- Fifteen seconds of ordinary idle follow the session. No forced GC is used for qualification
- Every clean close records live owned processes by PID plus creation identity, avoiding PID
  reuse. A timeout, missing observation, surviving owned process, or incomplete run fails the
  report check

Environment controls:

| Variable                           | Default  | Meaning                                                  |
| ---------------------------------- | -------- | -------------------------------------------------------- |
| `SELENE_PERFORMANCE_SAMPLES`       | `5`      | 3–20 sequential native launch samples                    |
| `SELENE_PERFORMANCE_SESSION_MS`    | `180000` | Total sustained timebox, including notice burst          |
| `SELENE_PERFORMANCE_NOTICE_CALLS`  | `10000`  | Controlled real IPC burst, 0–20,000 calls                |
| `SELENE_PERFORMANCE_LARGE_SOURCE`  | unset    | Additional real host-imported source-size probe          |
| `SELENE_PERFORMANCE_DIAGNOSTIC_GC` | unset    | Explicit before/after GC diagnostic; never qualification |

The source-size probe adds an inert feature-data file to an actual local project, imports it
through the normal lifecycle, resumes the host-owned project through the fenced reload API,
and measures 1,000 IPC snapshots and 60 authenticated UI selections. It keeps the visible
preview unchanged to isolate source-payload cost. It does not establish performance for all
permitted project sizes or every complex rendered component.

## Reference-fixture guardrails

`check-desktop-report.mjs` enforces completed, unforced, protected native observations rather
than interpreting missing data as zero. The current cloud-reference bounds are startup
p95 1,200 ms, first project create-to-paint 1,500 ms, selection p95 150 ms, project reopen
p95 500 ms, preview refresh p95 450 ms, presentation round trip p95 900 ms, snapshot IPC
p95 10 ms, initial linked JS 350 KiB/CSS 140 KiB, transient notices 128, fixture snapshot
64 Ki characters, idle inspected-renderer heap 256 MiB, and no surviving owned processes.
They are regression guardrails for this controlled fixture, not promises on arbitrary hardware.
The checker does not qualify forced-GC runs, absent resource coverage, or partial receipts.

## Observed comparison, 4 October 2026

Frozen baseline `615d791` and performance candidate `8a2d411` used production builds in the
same genuine Linux desktop/Secret-Service setup. These observations precede the richer final
starter/design integration. The integrated reference observation below provides a separate
artifact-tied receipt; it is not a new paired comparison with this earlier baseline.

| Journey                                   | Baseline p50 / p95 | Candidate p50 / p95 | Samples            |
| ----------------------------------------- | ------------------ | ------------------- | ------------------ |
| Actionable launchpad                      | 785 / 910 ms       | 616 / 730 ms        | 5 per version      |
| Authenticated selection to observed paint | 65.9 / 98.1 ms     | 65.6 / 98.5 ms      | 60 per version     |
| Warm preview refresh                      | 191.5 / 231.1 ms   | 182.6 / 232.2 ms    | 10 per version     |
| Presentation and return                   | 431.8 / 480.1 ms   | 433.3 / 500.2 ms    | 10 per version     |
| Warm project reopen                       | 212.8 / 323.8 ms   | 225.9 / 290.1 ms    | 12 per version     |
| Initial snapshot IPC                      | 2.6 / 5.6 ms       | 2.1 / 3.8 ms        | 100 per version    |
| Real notice-burst IPC                     | 3.2 / 8.2 ms       | 1.5 / 2.1 ms        | 10,000 per version |

Startup improved approximately 22% at the observed median; the growing-notice workload
improved approximately 74% at observed p95. Initial selection and the warm UI journeys are
mostly unchanged. First project create-to-paint was one observation per version and regressed
from 465 to 979 ms as runtime/workspace loading moved behind project intent. This tradeoff
must be disclosed. Host-runtime prewarming and restoring eager Vite were explored and did not
remove the observed first-create penalty; those experiments were discarded.

After the same notice burst, snapshot JSON shrank from 428,254 to 17,438 characters, and the
transient notice list was bounded at 128. Durable design/collaboration history, source,
baselines, review threads, AI requests, annotations, and handoff content remained unchanged
under regression tests.

The original baseline session became visibly white/unresponsive after 135 seconds and
55 mixed cycles; the receipt is explicitly incomplete. A separate focused test run overlapped
part of that baseline's later session, so its stall is not a controlled causal proof that the
notice cap alone prevents failure. Initial launch/journey samples preceded that reported overlap. Its last valid inspected-renderer
heap was 2,094 MiB. A separate diagnostic reduced a 1,517-MiB post-burst heap to 9.3 MiB
with explicit GC, so this is reclaimable allocation pressure, not proof of a permanent snapshot
leak. The candidate completed an unforced 181-second timebox and 97 cycles, then settled
naturally from 43.6 MiB to 34.5 MiB after idle, with one inspected DOM document. All five owned
process cleanup observations were empty. The candidate's sampled heap maximum was 276.6 MiB;
reported idle aggregate Electron CPU usage was 0.56%. Different completed cycle counts and
an incomplete baseline mean these memory observations are not a like-for-like percentage claim.

The candidate recorded an animation-frame scheduling-gap p50/p95 of 16.7 ms, maximum
66.7 ms, and one 54-ms long task during the instrumented session. This is scheduling telemetry,
not a physical-FPS claim.

Initial emitted renderer assets changed from a monolithic 760.5-kB JS / 239.2-kB CSS build to
304.3-kB initial JS / 114.8-kB initial CSS plus deferred cockpit assets. Original native
ResourceTiming arrays were empty and are not evidence of zero transfer bytes; the size figures
come from emitted files, with the final native/CDP resource regression proving the loaded graph.

## Integrated reference observation

The integrated production build completed the unforced native run on 4 October 2026 and passed
every existing reference-fixture guardrail. The directly observed committed test source was
`c160ded699f357288162480d719a0fa8d861a8b0`; its nine emitted main/preload/renderer files were
byte-identical to production build `fd74c94b707be8da2ad586b66394a5e69324441e`. Source and emitted
file fingerprints were unchanged before and after measurement. The receipt SHA-256 is
`042f000453768ac91143d21386e20e6c138d49efabd349077b64355fa758cae3` and the harness SHA-256 is
`65fcc90ebc33d59e3502adee27b2d3e4114387a519a0ab3cba56fd7694448017`.
A later publication SHA must be related by explicit source/input/artifact equivalence; it must
not be relabeled as the directly measured commit.

| Integrated journey                   | Observed p50 / p95 | Samples |
| ------------------------------------ | ------------------ | ------- |
| Actionable launchpad                 | 627.1 / 639.3 ms   | 5       |
| Authenticated selection to paint     | 48.7 / 78.0 ms     | 60      |
| Warm preview refresh                 | 207.0 / 253.4 ms   | 10      |
| Presentation and return              | 476.3 / 525.5 ms   | 10      |
| Warm project reopen                  | 264.8 / 313.1 ms   | 12      |
| Initial snapshot IPC                 | 3.0 / 5.3 ms       | 100     |
| Real notice-burst IPC                | 2.1 / 3.5 ms       | 10,000  |
| Post-session authenticated selection | 47.0 / 49.9 ms     | 60      |

First project create-to-paint was 991.1 ms in one observation. The earlier first-create tradeoff
remains: this is approximately one second, compared with the earlier baseline's single 465-ms
observation. Five launches and the small warm-journey samples do not establish population-wide
tail guarantees. The final selection harness uses observed exact-target geometry and real
native input, with current-document, authorization-stage, and exact host-selected-node fences.
Its preparation differs from the older locator-based samples, so the new selection numbers
must not be presented as a pure paired product-speedup percentage.

The 181.2-second timebox included the 10,000-call IPC burst and 75 mixed UI cycles, including
750 authenticated selections. Transient activity remained at 128 notices and the post-burst
fixture snapshot was 31,382 JSON characters. No forced GC was used. The inspected renderer's
sampled heap maximum was 251.4 MiB. After the additional source probe and 15 seconds of ordinary
idle, its heap settled to 24.6 MiB with one inspected DOM document. Main-process RSS was
396.3 MiB at idle and raw summed Electron interval CPU usage was 0.24%; these are separate
process observations, not a claim that the whole app uses only 24.6 MiB or a deduplicated
system-RAM total. Reported idle working sets across Electron processes summed to 982.4 MiB,
including shared pages; this is not an additive private-memory measurement. Main RSS was
373.9 MiB in the initial workspace, compared with 396.3 MiB at idle; main Node heap usage fell
from 79.6 MiB after the larger-source probe to 34.8 MiB at idle. All five owned-process cleanup
observations were empty, and no renderer crash or uncaught page error was observed.

The normal host-imported source probe used a 172,480-byte UTF-8 serialized workspace with four
source files, including inert feature data. Its 1,000 snapshots had IPC p50/p95 2.9/4.1 ms and
its 60 authenticated selections had p50/p95 48.0/58.9 ms. The enlarged snapshot was 186,077 JSON
characters. This is a payload-cost probe, not another three-minute/10,000-call large-source
stress run or a claim about arbitrary project sizes and rendered complexity.

The native window retained sandboxing, context isolation, disabled Node integration, and
genuine GNOME Secret Service protected storage. Initial DOM-linked emitted assets were
307,946 JS bytes and 128,418 CSS bytes. File ResourceTiming remained unavailable, so this is
the explicitly partial linked-asset inventory, not transfer bytes or a complete dynamic
request trace. Animation-frame scheduling gaps had p50/p95 16.7/16.7 ms and maximum 66.7 ms;
these remain scheduling telemetry rather than physical-display FPS. The original incomplete
baseline and its later concurrent test overlap still do not support a causal permanent-leak
or like-for-like memory-reduction percentage claim.

## Lazy-resource recovery

A missing cockpit module or stylesheet preserves the saved host-owned project while clearing
old project chrome, authenticated frame, and selection. A subsequent explicit Recent-project
reopen uses the existing fenced host reload capability; it does not repeatedly auto-reload.
This clears both browser module state and Vite's failed stylesheet-preload cache.

Qualified native probes reversibly withheld the exact emitted JS/CSS file after the initial
launchpad was ready, observed the saved-project failure and absence of stale frames, restored
the original inode/bytes/SHA-256, reopened the saved project, and verified the actual designer,
source-backed preview, and loaded cockpit stylesheet. `page.route` was not used as proof because
it did not intercept these native file-backed resources.
