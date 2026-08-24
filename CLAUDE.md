# PROJECT IDEA

This project is a practical sandbox for applying and experimenting with knowledge gained through Claude Certified Architect — Foundations.

# DOCUMENTATION

`docs/` is the source of truth for this project's conceptual and methodological
material. The documentation map below is always in context; the documents
themselves are read on demand — never import the whole tree.

@docs/INDEX.md

## Mandatory workflow

1. **Before starting any task in this project**, consult the map above
   (`docs/INDEX.md`) and identify the documents relevant to the task.
2. **Read every relevant document in full** (the files are small) before
   writing code, answering questions, or making design decisions. Do not act
   on the one-line summaries in the map alone.
3. If no document in the map is relevant, say so briefly and proceed.

## Priority on conflict

- Documentation in `docs/` **overrides your general knowledge**. When they
  disagree, follow the documents.
- When a task or term is ambiguous, **find and read the corresponding
  document first** instead of guessing. For framework terminology (4Ds,
  interaction modes, etc.), the glossary is
  `docs/AI Fluency (Framework & Foundations)/Al Fluency- Key Terminology Cheat Sheet.md`.
- For runtime behavior the code in `src/` is authoritative; `docs/` covers
  concepts and methodology, not the API implementation.

## Maintenance

- When adding, removing, or renaming a `.md` file under `docs/`, update
  `docs/INDEX.md` in the same change.

# RULES

1. All code comments must be written only in English.
2. Core foundational logic must be covered by comments. Keep comments concise while ensuring they remain meaningful and useful to the reader.
