// Turn a Kubernetes API failure from the custom deployer into an error the
// tenant can act on — without repeating anything from the request.
//
// The API server's Status message echoes offending VALUES
// (`env[0].value: Invalid value: "<the tenant's token>"`), and the result
// lands in `deployments.last_error` and the HTTP response. So the message is
// built only from what identifies the problem: the object, the HTTP status,
// and for a 422 the rejected FIELD PATHS plus the kind of rejection. Field
// paths are indices and schema keys, never values.
//
// Before this, every failure became `Failed to patch Deployment 'x' to
// cluster` — a bare Error the API rendered as "An unexpected error occurred",
// so a duplicate port name and an unreachable API server looked the same.

import { ApiError } from '../../shared/errors.js';
import { httpStatusOf } from '../../shared/k8s-errors.js';

/** What a Status cause's `reason` means, phrased without the value. */
const CAUSE_TEXT: Readonly<Record<string, string>> = {
  FieldValueDuplicate: 'duplicate value',
  FieldValueInvalid: 'invalid value',
  FieldValueRequired: 'required',
  FieldValueNotFound: 'not found',
  FieldValueNotSupported: 'unsupported value',
  FieldValueForbidden: 'forbidden',
  FieldValueTooLong: 'too long',
  FieldValueTooMany: 'too many items',
  FieldValueTypeInvalid: 'wrong type',
};

/** Field paths are bounded so a pathological Status cannot bloat the row. */
const MAX_FIELDS = 5;

interface StatusCause { readonly reason?: unknown; readonly field?: unknown }

function parseCauses(err: unknown): readonly StatusCause[] {
  const body = (err as { body?: unknown }).body;
  let status: unknown = body;
  if (typeof body === 'string') {
    try { status = JSON.parse(body); } catch { return []; }
  }
  const causes = (status as { details?: { causes?: unknown } } | null)?.details?.causes;
  return Array.isArray(causes) ? (causes as StatusCause[]) : [];
}

export function describeK8sApplyError(
  err: unknown,
  kind: string,
  name: string,
  op: 'create' | 'patch',
): ApiError {
  const status = httpStatusOf(err);
  if (status === 422) {
    const rejected = parseCauses(err)
      .filter((c): c is { reason?: unknown; field: string } => typeof c.field === 'string' && c.field.length > 0)
      .slice(0, MAX_FIELDS);
    const fields = rejected.map((c) => c.field);
    const parts = rejected.map((c) => {
      const text = typeof c.reason === 'string' ? CAUSE_TEXT[c.reason] : undefined;
      return text ? `${c.field} (${text})` : c.field;
    });
    return new ApiError(
      'K8S_SPEC_REJECTED',
      parts.length > 0
        ? `Kubernetes rejected the ${kind} '${name}': ${parts.join('; ')}`
        : `Kubernetes rejected the ${kind} '${name}'`,
      422,
      { kind, name, fields },
    );
  }
  const where = status === undefined ? 'no HTTP response from the Kubernetes API' : `Kubernetes API HTTP ${status}`;
  return new ApiError('K8S_APPLY_FAILED', `Failed to ${op} ${kind} '${name}' (${where})`, 502, { kind, name });
}
