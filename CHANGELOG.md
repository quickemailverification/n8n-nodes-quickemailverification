# Changelog

All notable changes to `@quickemailverification/n8n-nodes-quickemailverification` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-08-07

Compliance release for the n8n Creator Portal. The submission of 1.0.1 was
rejected by `@n8n/scan-community-package`, whose ruleset is stricter than the
`eslint-plugin-n8n-nodes-base` config used locally.

### Removed

- **Breaking:** the **File Path** upload method for **List Verification Send File**,
  along with the **Upload Method** parameter that selected it. Reading a file from
  the n8n host requires `node:fs`, which n8n Cloud forbids in community nodes. Use
  the **Input Binary Field** instead, feeding the node a binary property from a
  preceding Read/Write Files or HTTP Request node. Workflows that used File Path
  must add such a node ahead of this one.

### Changed

- `inputs`/`outputs` now use `NodeConnectionTypes.Main` instead of the `'main'`
  string literal.
- Errors escaping the execute loop are wrapped in `NodeApiError` rather than
  re-thrown raw, so they reach the UI with node context. Existing `NodeApiError`s
  pass through unchanged and `NodeOperationError` messages are preserved.
- The multipart boundary is derived without `node:crypto`, and is now checked
  against the payload so uniqueness is guaranteed rather than probabilistic.
- Report options are listed alphabetically; option defaults are literals.

### Added

- `peerDependencies` with `"n8n-workflow": "*"`, as the portal requires.
- Light and dark icon variants for both the node and the credential.

### Maintenance

- The minimum Node.js version is now 22.22, matching n8n's own `engines`
  requirement. The previous floor of 18.10 advertised support for releases that
  are end-of-life and that no current n8n host can run.
- The publish workflow builds on Node 24 (Active LTS) instead of 22, and
  `@types/node` tracks the same major.

## [1.0.1] - 2026-08-06

Maintenance release. No functional changes — the same operations, parameters and
API behaviour as 1.0.0.

### Changed

- Published from GitHub Actions with an [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  attestation, so the package can be cryptographically verified as having been built
  from this repository at this commit. This is required for submission to the n8n
  Creator Portal; 1.0.0 was published manually and carries no attestation.

## [1.0.0] - 2026-07-29

Initial release.

### Added

- **Verify an Email Address** operation – single email verification. Returns the Verify An Email Address response exactly as the API sends it (`result`, `reason`, `disposable`, `accept_all`, `role`, `free`, `email`, `user`, `domain`, `mx_record`, `mx_domain`, `safe_to_send`, `did_you_mean`, `success`, `message`), with no added or renamed fields.
- Every request identifies itself with a `User-Agent` of `quickemailverification-n8n/v1.0.0 (https://github.com/quickemailverification/n8n-nodes-quickemailverification)`.
- **List Verification Send File** operation – uploads a file to QuickEmailVerification for bulk email verification, returning immediately with `success`, `message`, `file_name`, `file_id`, `item_count`, and `return_url`. Verification runs server-side; the node does not block waiting for it.
  - **Input Type** – `File` (a binary property from a previous node, or an absolute path on the n8n host) or `Items` (build the CSV from input items).
  - **Item Input Type** for `Items` – **Field Assignment**, **JSON Input**, or **Mapped**. Values may be single addresses, comma/semicolon/newline separated lists, arrays, or objects with an email field. Addresses are de-duplicated case-insensitively, and anything that is not a valid address fails the item with the offending value named.
  - **Combine Items** (default on) – merge every input item into one upload instead of one upload per item.
  - **Include File** – return the generated CSV as binary data.
  - Optional **Filename**, **Return URL**, and **Notification Email**.
- **List Verification File Status** operation – retrieves the verification status of a previously submitted file, returning `file_id`, `file_name`, `upload_date`, `file_status` (`Queued` / `Processing` / `Complete` / `Failed`), `complete_percentage`, `error_reason`, `return_url`, `total_email`, `result_counts`, `completed_date`, and `processing_time`.
- **List Verification Get File** operation – downloads the verification results for a previously submitted file, in the chosen report (full / safe-to-send / valid / invalid / unknown).
  - **Output** – `Emails` (one item per email, with optional duplicate removal) or `File` (the raw CSV as binary data).
  - **Include File** – attach the CSV to the `Emails` output as well, on the first item.
  - The report keeps the file name the API served it under (from `Content-Disposition`), so n8n's binary panel shows the name, extension, mime type and size with working **View** and **Download** buttons. **Output Filename** and **Output Binary Field** override the name and target property.
  - Reports `remote_file_name`, `file_extension`, `mime_type`, and `file_size` alongside the file.
- **List Verification Delete File** operation – deletes a previously submitted verification file and its associated results, returning `success`, `message`, `file_name`, and `file_id`. The API only allows this for files submitted through the API, and not while a file is being processed.
- **QuickEmailVerification API** credential with an API-key field, request authentication, and a connection test. The test calls the free sandbox endpoint, so saving or retesting a credential never spends a verification credit.
- Graceful error handling with `NodeOperationError` / `NodeApiError` and friendly messages for authentication errors, insufficient credits, rate limits, invalid files/parameters, missing files, and files that are not finished processing. Works with **Continue On Fail**, which collects `{ "success": false, "message": "…" }` per item.
