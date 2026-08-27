/**
 * Home-directory resolution for goal state paths.
 *
 * Read at call time (not import time) so tests can point HOME at a temp
 * directory without module-load-order games, and so a deployment that must
 * relocate the goal stores can do so with PI_WEB_UI_GOAL_HOME.
 */

import os from 'node:os';

export function homedirOverride(): string {
  return process.env.PI_WEB_UI_GOAL_HOME || process.env.HOME || os.homedir();
}
