# Examples

Each file demonstrates something the language server reports (or, for the clean
ones, deliberately nothing). The first line of every file lists the diagnostic
codes it is expected to produce; `test/examples.test.ts` runs the checker over
this directory and fails if the set of codes differs, so these double as
regression tests and as a tour of what the server catches.

Open any of them in Neovim with the server installed to see the messages, hover
over expressions to see their types, and press `<Leader>la` on a diagnostic to
apply its quick fix.
