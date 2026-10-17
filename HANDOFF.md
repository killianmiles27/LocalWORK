# LocalWORK maintainer entry point

Read README.md for the product overview, docs/SETUP.md for setup, and docs/PROJECT_CONTEXT.md before changing the implementation. Security boundaries are in SECURITY.md; current release checks are in docs/PUBLIC_READINESS.md.

The repository is self-contained source for the Windows x64 app. Strata, model weights, generated work, audit reports, and local deployment backups stay outside Git. Build the pinned runtime resources using the scripts rather than copying a developer's installation.

There are no machine-specific installation or model defaults. Preserve users' saved settings and data. Use isolated app data for acceptance tests. Never relabel a stub-model or website-specific probe as a general model-quality result.
