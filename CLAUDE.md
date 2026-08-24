# PROJECT IDEA

This project is an example of integrating with the Anthropic Messages API,
built as a practical sandbox for applying and experimenting with knowledge
gained through Claude Certified Architect — Foundations. It starts from the
basics of a clean API integration and is meant to grow with more use cases
over time.

# DOCUMENTATION

`docs/` holds personal course notes (AI Fluency materials). It is **not** a
source of truth for this project: it is gitignored, exists only on this
machine, and may be missing entirely on other copies of the repository.

- If `docs/` is present locally, `docs/INDEX.md` maps its contents, including
  the terminology glossary at
  `docs/AI Fluency (Framework & Foundations)/Al Fluency- Key Terminology Cheat Sheet.md`.
- Consult those notes only when a task explicitly touches course concepts or
  framework terminology (4Ds, interaction modes, etc.). Never block a task
  because `docs/` is absent.
- Read individual documents on demand; never import the whole tree.

## Priority on conflict

- For runtime behavior, the code in `src/` is authoritative.
- `docs/` notes cover concepts and methodology, not the API implementation;
  they do not override the code or these rules.

## Maintenance (local notes)

- When adding, removing, or renaming a `.md` file under `docs/`, keep the
  local `docs/INDEX.md` up to date so the map stays usable.

# RULES

1. All code comments must be written only in English.
2. Core foundational logic must be covered by comments. Keep comments concise while ensuring they remain meaningful and useful to the reader.
