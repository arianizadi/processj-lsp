/**
 * ProcessJ to CSPm, for FDR, and FDR's answers back in ProcessJ terms.
 *
 *   translateProgram({ units, index })        the whole program, from main (MAIN)
 *   translateProcedure({ units, index }, n)   one procedure with a harness (named after it)
 *   findRefines() / runRefines(refines, file)  run FDR on the result
 *   explain(model, run, { uri })              refines' output -> VerificationReport (src/verification.ts)
 *   checkWithFdr({ units, index, uri, ... })  all of the above in one call
 *   fdrDiagnostics(report) / formatFdrReport  what an editor shows
 *   stateMachines(model)                      each procedure's communication state machine
 *
 * The model's source map says which definition is which statement, which
 * network leaf is which process instance (src/verification.ts identities),
 * which channel is which declaration and which assertion is which check.
 */
export { drawnArguments, translateProgram, translateProcedure, type CspUnit, type TranslateInput } from './translate';
export type {
  CheckedWith,
  CspAssertion,
  CspChannelInfo,
  CspConstructor,
  CspDefinitionInfo,
  CspDefinitionKind,
  CspDiagnostic,
  CspErrorSite,
  CspModel,
  CspNetworkNode,
  CspOperation,
  CspParam,
  CspProcessInfo,
  CspSourceMap,
  CspTransition,
  CspTransitionStep,
  CspUse,
  TranslateOptions,
} from './model';
export { machineKey, machineOfState, stateMachines, type CspMachine, type CspMachineState, type CspMachineTransition } from './machine';
export {
  defaultMemoryLimit,
  findRefines,
  leafBehaviours,
  networkBehaviour,
  parseFramedJson,
  parseState,
  refinesCandidates,
  refinesNotFoundMessage,
  runRefines,
  type FdrBehaviour,
  type FdrCounterexample,
  type FdrResult,
  type FdrRun,
  type LeafBehaviour,
  type RefinesModel,
  type RefinesRunner,
  type RunOptions,
} from './fdr';
export { explain, matchResults, normalizeAssertion, processNames, sameChannel, specErrors, type ExplainOptions } from './explain';
export { checkWithFdr, type FdrCheck, type FdrCheckRequest } from './check';
export { includePolicy, includeProblemsText, includesIn, prepareIncludes, type IncludedFile, type IncludePolicy, type IncludeProblem, type PreparedModel } from './includes';
export { fdrDiagnostics, formatFdrReport, isPartialDeadlock, lensVerdict, type FdrDiagnostic, type ReportContext } from './report';
