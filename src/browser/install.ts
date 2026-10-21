/**
 * A ProcessJ install in the in-memory file system, at the path PROCESSJ_HOME
 * names: the standard library's headers (src/browser/stdlib.json, made at
 * build time from test/fixtures/include, which matches the compiler's
 * include/JVM) and the files config.ts recognises an install by. So
 * findInstall, indexLibrary, loadLibrary and import resolution work as they
 * do on disk. Nothing in it can run: the class and the jars are empty.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNTIME_JARS } from '../config';
import stdlib from './stdlib.json';

export const INSTALL_DIR = '/processj';

export function installStandardLibrary(): void {
  for (const [file, text] of Object.entries(stdlib as Record<string, string>)) {
    fs.writeFileSync(path.join(INSTALL_DIR, 'include', 'JVM', file), text);
  }
  fs.writeFileSync(path.join(INSTALL_DIR, 'bin', 'ProcessJc.class'), '');
  for (const jar of RUNTIME_JARS) fs.writeFileSync(path.join(INSTALL_DIR, 'resources', 'jars', jar), '');
  // Reports and generated files go to private folders under the temporary folder.
  fs.mkdirSync('/tmp', { recursive: true });
}
