# Zod Node ESM runtime

Version: 4.4.3. License: MIT (see LICENSE). Source: the installed npm zod package audited on 2026-11-12; project https://github.com/colinhacks/zod.

The selected package.json, LICENSE and all .js modules are copied; nine trailing-whitespace lines in v3/types.js and v4/core/{api,checks,schemas}.js are removed for the repository whitespace check. All other bytes are unchanged. CommonJS builds, TypeScript sources and declarations are omitted; this is an ESM runtime subset, not a complete npm distribution.

The accelerator ledger imports ../../zod/index.js explicitly. Both the plugin manager and CLI installations carry these files, so the ledger does not rely on a separately installed original plugin or a profile-level zod dependency.

Copied files: 107. SHA-256 of sorted relative path, NUL, bytes, NUL: `5854e000390cb302326cbb259ed795d18273dec775a7047fa1f66b3c6849c9fe`.
