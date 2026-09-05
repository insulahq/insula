import { useMutation } from '@tanstack/react-query';
import type { UpdateProfileRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/** Wire shape from @insula/api-contracts. */
type UpdateProfileInput = UpdateProfileRequest;

interface ProfileResponse {
  readonly data: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly role: string;
    readonly timezone?: string | null;
  };
}

export function useUpdateProfile() {
  return useMutation({
    mutationFn: (input: UpdateProfileInput) =>
      apiFetch<ProfileResponse>('/api/v1/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
  });
}
