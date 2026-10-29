/**
 * What a compose create accepts from the parser: exactly what Validate calls
 * `ok` (validateComposeSpec) — a spec, and no error among the issues.
 *
 * The parser reports a refused field (`cap_add: [SYS_ADMIN]`, `privileged`,
 * `devices`, `mem_limit`, …) as an error issue and leaves the field out of the
 * spec it still returns. Create used to check only that a spec came back, so it
 * built the stack without the field: a container that "deployed fine" minus the
 * capability or memory its YAML asked for. The editor's Validate showed the
 * error; Deploy did not need a Validate first.
 */
import { ApiError } from '../../shared/errors.js';
import type { ComposeParseResult } from './compose-parser.js';
import type { CustomDeploymentIssue, CustomDeploymentSpec } from './schema.js';
import { withResolvedLines } from './yaml-line-map.js';

export function firstErrorIssue(issues: readonly CustomDeploymentIssue[]): string {
  const err = issues.find((i) => i.severity === 'error');
  return err ? `${err.code}: ${err.message}` : 'Validation failed';
}

/** The parsed spec, or CUSTOM_DEPLOYMENT_INVALID (422) with every issue, each with its line. */
export function composeSpecForCreate(parsed: ComposeParseResult, composeYaml: string): CustomDeploymentSpec {
  if (parsed.spec && !parsed.issues.some((i) => i.severity === 'error')) return parsed.spec;
  throw new ApiError(
    'CUSTOM_DEPLOYMENT_INVALID',
    firstErrorIssue(parsed.issues),
    422,
    { issues: withResolvedLines(composeYaml, parsed.issues) },
  );
}
