/**
 * Version identity for the lab.
 *
 * Bumped whenever the manifest schema or a frozen tolerance set changes, so a
 * record can always be interpreted by the code that produced it — and so an old
 * record can never be silently re-read under new measurement rules.
 */

export const LAB_VERSION = '1.0.0';

/** Version of the run manifest + report schema. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Version of the oracle's frozen tolerance set. Any change to the numeric
 *  tolerances in `oracle.ts` must bump this, because it invalidates the RED
 *  calibration evidence recorded against the previous numbers. */
export const ORACLE_TOLERANCE_VERSION = 1;

export const REPORT_SCHEMA_VERSION = 1;
