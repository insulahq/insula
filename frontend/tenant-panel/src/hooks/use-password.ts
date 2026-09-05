import { useMutation } from '@tanstack/react-query';
import type { ChangePasswordRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/** Wire shape from @insula/api-contracts. */
type ChangePasswordInput = ChangePasswordRequest;

interface ChangePasswordResponse {
  readonly data: { readonly message: string };
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      apiFetch<ChangePasswordResponse>('/api/v1/auth/password', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
  });
}
