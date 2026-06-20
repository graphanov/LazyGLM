---
name: programming
description: "Disciplined coding across JS/TS, Python, Go, Rust. Strict types, real error handling, no slop."
---

# programming

## Defaults
- **Types strict**: no `any` in TS, no untyped `dict` where a dataclass fits, enable strict lint.
- **Error handling**: handle errors at boundaries; never swallow. Propagate with context.
- **Naming**: specific over clever. `userCount` not `n`. `fetchUserProfile` not `getData`.
- **Small functions**: one job. If you need a comment to explain the function, the name is wrong.

## Per language
- **JS/TS**: ESM, `const` by default, async/await (no raw promise chains), prefer `node --test`.
- **Python**: type hints, `if __name__ == "__main__"`, `venv`, `pytest`.
- **Go**: `gofmt`, explicit error returns, table-driven tests.
- **Rust**: `clippy` clean, `Result`/`?`, no `unwrap` in production paths.

## Verification
Every change ships with a way to verify it: a test, a build command, or a runnable check. Run it.
