# Decisions

Append-only CIO approvals. One file per decision: `YYYY-MM-DD-<memo-id>.md`.
The executor pays only what matches an approval and `loop/policy/`.

Each decision also has a machine-readable `<date>-<memo-id>.json` with
`{"id","memo","experiment","cap","expires","approvedBy":"cio"}`. See `executor/README.md`.
