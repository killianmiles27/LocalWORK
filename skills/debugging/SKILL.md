---
name: debugging
description: Find the root cause of a bug, error or failing test before changing code
---
Adapted from Hermes Agent's systematic-debugging skill (MIT, Nous Research).

No fix before you know why it fails. A fix for a symptom is a failure.

1. Read the whole error: message, stack trace, file and line, error code. Search the code for the error text.
2. Make it fail on demand with the fastest loop you can: one failing test, one command with fixed input, one HTTP request. If it fails only sometimes, run it many times.
3. Check what changed: git diff, git log -5 on the files involved, new dependencies or config.
4. In a chain of parts (UI -> API -> database, build -> deploy), log what goes in and out at each boundary to find where good input becomes bad output. Trace a bad value back to where it is first set.
5. Find working code that does the same thing and list every difference, however small.
6. One hypothesis at a time: "X fails because Y". Make the smallest change that tests it. Wrong? Undo it and form a new one; do not stack fixes.
7. Fix the cause: first a test or repro that fails, then one change, then that test passes and the full suite still passes.
8. Three failed fixes, or each fix breaks something elsewhere: stop. The design is probably wrong. Tell the user what you tried and learned before trying more.
