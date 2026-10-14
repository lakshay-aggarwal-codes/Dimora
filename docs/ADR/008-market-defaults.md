# ADR-008: Market defaults: India, INR, Asia/Kolkata

- Status: Accepted
- Date: 2026-10-14
- Source: P00-T03; `MASTER_ROADMAP.md`

## Context

The code and demo data mix an Indian presentation (rupee sign, `en-IN` number formatting, an "+18% GST" label) with mostly US seed locations. The intended market was not stated in the repository.

## Decision

Default market is **India**: currency INR (paise, see ADR-002), time zone `Asia/Kolkata` (see ADR-003), `en-IN` number formatting, English UI. Tax shown at checkout is **illustrative** and configurable, not a statement of legal tax advice. Demo and seed data should use Indian locations (task P19-T02). Currency and time zone are stored per record, so a later market change does not require a schema change.

## Consequences

- This is a default the owner can overturn; changing it later means changing seed data and a few config values, not the data model.
- Tax rules are not legally validated; the UI and docs must label them illustrative.
- Multi-currency conversion is out of scope.

## Alternative rejected

International (USD, US time zones) as the default. Rejected: the existing UI and the owner's context point to India, and storing currency/time zone per record keeps the door open.
