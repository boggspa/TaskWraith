# TaskWraith positioning

## The defensible claim

TaskWraith is a **credible, differentiated local-first control plane for working
with multiple coding-agent providers**. It gives provider seats a shared or
isolated work topology, explicit authority, and inspectable local evidence;
qualified tool-capable seats also receive workspace-scoped tools and approvals.

That is stronger and more useful than “provider switching,” but it is not a
claim of category leadership, universal native-tool parity, or enterprise
compliance. The proof standard is live behaviour at a named version, not the
size of the feature list.

## What is different

- **Governed orchestration:** Ensemble seats can debate and hand off in one
  transcript; sub-threads can run isolated work in parallel and return an
  explicitly untrusted result. Boss/Captain authority, per-seat permissions,
  approval gates, and audit events keep coordination visible.
- **Containment with boundaries:** TaskWraith-brokered workspace operations are
  policy checked and auditable. Provider-native CLIs and project-level MCP
  loading vary, so their containment claims require version-pinned live
  canaries. A Read-only label is not, by itself, proof that a hostile native MCP
  server cannot start.
  Managed Cursor uses Path-B: always-enabled contained `cursor-agent` with
  hard-pinned `--sandbox enabled` and seat-routed read-only vs write argv.
  Own-account skills/plugins/MCP may load but are sandbox-bounded; TaskWraith
  does not mediate Cursor per-tool approvals. Treat the sandbox as an honest
  partial backstop (file-write impact bound for normal project workspaces, not
  a full egress seal).
- **Honesty is part of the product:** Cache behaviour is labelled Guaranteed
  only where TaskWraith controls the API request, Automatic where a provider
  reports observed implicit caching, and Best-effort on opaque CLI paths.
  Native and emulated forks are labelled separately, and returned child output
  is not silently promoted to trusted instruction.

## Choose the smallest topology that fits

| Need                                              | Use        | Why                                                                       |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| One clear task, one execution context             | Solo chat  | Lowest cost and coordination overhead                                     |
| Parallel, noisy, or context-isolated work         | Sub-thread | Independent provider session; result returns with provenance              |
| Deliberation, hand-offs, or role-separated review | Ensemble   | Peers share the transcript and can challenge work in sequence or parallel |

Sub-threads are depth-one in the current product. Ensemble seats share transcript
context, so extra participants add cost and noise as well as perspective.

## Default small panels

Start with **Boss + Captain + one Specialist**. Add a second Specialist only
when the task crosses domains, and add one **Outsider** when independent dissent
is worth the extra turn. Keep one write-capable seat by default; give review and
outsider seats Read-only posture until the task requires more. Cursor seats run
under Path-B native-sandbox containment without TaskWraith per-tool approvals,
so keep Cursor on Read-only posture where approval-mediated review matters.

- **Delivery (3–4):** Boss, Captain/writer, test Specialist, optional Outsider.
- **Risky change (4–5):** Boss, Captain/writer, security Specialist, test
  Specialist, optional Outsider.
- **Investigation (3–4):** Boss, Captain, debugging Specialist, adversarial
  Outsider.

Twenty participants is a capacity ceiling, not a recommended starting panel.

## Release boundary

The latest tagged public baseline is **v1.8.5**. This checkout is source-ahead;
its compact default panels and any other Unreleased entries are implementation
evidence, not shipped capability, until a new tag and matching artifacts are
published. Public claims should name the release or commit they were verified
against.
