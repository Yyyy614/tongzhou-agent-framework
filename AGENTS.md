# Framework implementation rules

- Keep industry and department behavior in plugins and fixtures, never the kernel.
- Identity, authorization, task state, memory ACL, usage and release binding belong to the trusted host.
- Plugin permissions are requests, never grants. Validate tool input and output against the installed schema.
- Each agent has independent persistent memory; indexes and frontmatter do not grant access.
- Never print or commit credentials, run tokens, database passwords or raw authorization headers.
- For new behavior, first run a failing public-interface test, then implement the smallest working slice.
- Use pnpm test, pnpm check and pnpm build. A provider fixture is not a live DeepSeek test.
- Read the relevant module and contract rather than loading all logs or specifications.
