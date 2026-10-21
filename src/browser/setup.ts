/**
 * What the worker needs before the server module runs: the install it finds
 * through PROCESSJ_HOME, and the graph viewer's page script, which the
 * bundle carries (there is no dist/src/graph/client/viewer.js beside it).
 */
import { setViewerScript } from '../graph/render-html';
import { INSTALL_DIR, installStandardLibrary } from './install';

/** dist/src/graph/client/viewer.js, put in by the bundler (scripts/build-browser.mjs). */
declare const PROCESSJ_VIEWER_SCRIPT: string;

installStandardLibrary();
process.env.PROCESSJ_HOME = INSTALL_DIR;
setViewerScript(PROCESSJ_VIEWER_SCRIPT);
