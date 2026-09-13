# Channels proof records

This directory holds the Channels P1–P6 proof and review family. The P3
enabled proof still blob-pins the historical `docs/channels-p3-*.md` paths at
the acceptance commits; `scripts/channels-p3-enabled-proof.cjs` aliases those
paths to the files here so a later candidate can move the family without
rewriting the accepted decision text.

`CHANNEL_AGENT_REVIEW_RECORD` keeps the acceptance-commit path
`docs/channels-p3-adversarial-review.md` so the packaged gate identity stays
byte-stable. Resolve the live copy at
[`channels-p3-adversarial-review.md`](channels-p3-adversarial-review.md).

| Record                | Path                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| P1 main contract      | [`channels-p1-main-contract.md`](channels-p1-main-contract.md)           |
| P1 proof              | [`channels-p1-proof.md`](channels-p1-proof.md)                           |
| P2 proof              | [`channels-p2-proof.md`](channels-p2-proof.md)                           |
| P3 adversarial review | [`channels-p3-adversarial-review.md`](channels-p3-adversarial-review.md) |
| P3 Muse delta review  | [`channels-p3-muse-delta-review.md`](channels-p3-muse-delta-review.md)   |
| P3 security design    | [`channels-p3-security-design.md`](channels-p3-security-design.md)       |
| P4 proof              | [`channels-p4-proof.md`](channels-p4-proof.md)                           |
| P5 proof              | [`channels-p5-proof.md`](channels-p5-proof.md)                           |
| P6 proof              | [`channels-p6-proof.md`](channels-p6-proof.md)                           |
