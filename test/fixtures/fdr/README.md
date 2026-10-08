refines output (`--format=framed_json --divide`, one search worker, parsed by
`src/csp/fdr.ts`) for the programs of `test/fdr.test.ts` and
`test/fdr-graph.test.ts`, so the explanation and graph tests run without FDR
(the server tests replay them too, `test/fdr-recordings.ts`). Each file names a
hash of the model it was recorded for (`model`); when the translator generates
something else, the tests say so, and the files are recorded again with FDR
installed: `PJ_RECORD_FDR=1 npm test` (one test's with `node --test
--test-name-pattern=<its name> dist/test/<file>.js`). A termination or
determinism counterexample can come out different from one recording to the
next, even with one worker.
